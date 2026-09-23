/**
 * The plugin: gate → daily cap → memo → ask → decide → apply, with fail-open semantics.
 *
 * What the hook spike established, and what this file relies on:
 * - `setup` runs once per process, so all state here is process-local (closures over `setup`).
 * - `ctx.session.hook(name, callback)` registers; callbacks mutate the event in place and the host
 *   builds the outgoing request from the object we mutated.
 * - Mutations are NOT persisted to the session: every model call hands us pristine messages, so
 *   decisions are remembered in a memo and re-applied on every request.
 *
 * `@opencode/plugin` is imported for types only — the host resolves plugin dependencies from its own
 * cache, so a runtime import of that devDependency would be a hazard.
 */

import type { Message as V2Message } from "@opencode/ai";
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session";
import type { Plugin } from "@opencode/plugin";
import {
  batchCalls,
  collectToolCalls,
  decideCall,
  estimateTokens,
  fitState,
  noulAnswer,
  questionsFor,
} from "fast-jev-compaction";
import type { CallDecision, ToolCall } from "fast-jev-compaction";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyDecisions, TRUNCATION_PREFIX } from "./apply.js";
import { toLibraryMessages } from "./adapter.js";
import { createTelemetry, stateDirectory, type RunRecord, type Telemetry } from "./telemetry.js";
import {
  createAsker,
  resolveProviderConfig,
  warnOnce,
  type DecisionAnswers,
  type DecisionAsker,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "./provider.js";

/** Characters of a dropped result body to keep; deliberately not an option. */
const TRUNCATE_HEAD_CHARS = 300;

/** Hard ceiling on decision requests per day, matching the reference port. */
const DAILY_REQUEST_CAP = 200;

/** File inside the state dir that tracks today's reservations. */
const USAGE_FILE = "usage.json";

interface PluginState {
  readonly config: ResolvedProviderConfig;
  /** The environment captured at `setup`, so key lookups do not re-read `process.env` per request. */
  readonly env: Record<string, string | undefined>;
  /** One asker per session, so `x-opencode-session` and the User-Agent ride in the request headers. */
  readonly askers: Map<string, DecisionAsker>;
  /** `tool_use_id` → action. Monotonic: a dropped call is never asked about again. */
  readonly memo: Map<string, CallDecision["action"]>;
  readonly telemetry: Telemetry;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Rough size of the outgoing request, using the library's calibrated estimator. */
function estimateRequestTokens(event: {
  messages?: readonly V2Message[];
  system?: readonly { text?: string }[];
  tools?: unknown;
}): number {
  const parts: string[] = [];
  for (const message of event.messages ?? []) parts.push(JSON.stringify(message.content ?? []));
  for (const part of event.system ?? []) parts.push(part?.text ?? "");
  parts.push(JSON.stringify(event.tools ?? {}));
  return estimateTokens(parts.join("\n"));
}

/** Local calendar day; the daily cap resets on it. */
function usageDay(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Reserves up to `count` decision requests for today and reports how many may actually be sent (0
 * when the cap is reached). The file is written temp-then-rename, so a reader never sees a torn or
 * half-written file — but the read-modify-write cycle is not multiprocess-safe: two processes
 * reserving at the same time can read the same `used` value and each lose the other's increment.
 * An unusable state directory fails open with a one-shot warning: losing the cap beats silently
 * switching compaction off.
 */
function reserveRequests(count: number, cap: number = DAILY_REQUEST_CAP): number {
  if (count <= 0) return 0;

  const directory = stateDirectory();
  const file = join(directory, USAGE_FILE);
  const day = usageDay();

  try {
    mkdirSync(directory, { recursive: true });

    let used = 0;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { day?: unknown; requests?: unknown };
      if (raw?.day === day && typeof raw.requests === "number" && Number.isFinite(raw.requests)) {
        used = Math.max(0, Math.floor(raw.requests));
      }
    } catch {
      // missing or unreadable usage file: today starts at zero
    }

    const allowed = Math.max(0, Math.min(count, cap - used));
    if (allowed > 0) {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ day, requests: used + allowed }), { mode: 0o600 });
      renameSync(temp, file);
    }
    return allowed;
  } catch (error) {
    warnOnce(
      "plugin:usage-file",
      `fast-opencode-compaction: could not track daily request usage (${errorText(error)}); the daily cap is not enforced`,
    );
    return count;
  }
}

function askerFor(state: PluginState, sessionID: string): DecisionAsker {
  const cached = state.askers.get(sessionID);
  if (cached) return cached;

  const headers = {
    ...state.config.headers,
    ...(sessionID ? { "x-opencode-session": sessionID } : {}),
  };
  const asker = createAsker({ ...state.config, headers }, fetch, state.env);
  state.askers.set(sessionID, asker);
  return asker;
}

/** `noulAnswer` throws on a missing or malformed answer; one bad answer skips one call, no more. */
function probabilityOf(answers: DecisionAnswers, name: string): number | undefined {
  try {
    return noulAnswer(answers, name);
  } catch {
    return undefined;
  }
}

/** Turns one batch's answers into memo entries. Keep decisions are not remembered: there is nothing to re-apply. */
function rememberAnswers(state: PluginState, batch: readonly ToolCall[], answers: DecisionAnswers): void {
  for (const call of batch) {
    const keepCall = probabilityOf(answers, `call_${call.id}`);
    const keepResult = probabilityOf(answers, `result_${call.id}`);
    if (keepCall === undefined || keepResult === undefined) continue;

    const decision = decideCall(call, { keepCall, keepResult }, { keepThreshold: state.config.keepThreshold });
    if (decision.action !== "keep") state.memo.set(call.tool_use_id, decision.action);
  }
}

/** Rebuilds decisions for every remembered call, so each request gets the same pruning. */
function memoDecisions(state: PluginState, calls: readonly ToolCall[]): CallDecision[] {
  const decisions: CallDecision[] = [];
  for (const call of calls) {
    const action = state.memo.get(call.tool_use_id);
    if (!action) continue;
    decisions.push({
      id: call.id,
      tool: call.tool,
      keepCall: 0,
      keepResult: 0,
      action,
      reason: action === "drop_call" ? "call_dropped" : "result_dropped",
    });
  }
  return decisions;
}

async function onContext(state: PluginState, event: SessionContext): Promise<void> {
  const started = Date.now();
  state.telemetry.trace(`context called session=${event.sessionID}`);

  const run: RunRecord = {
    reason: "step",
    stage: "",
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    calls: 0,
    dropped: 0,
    truncated: 0,
    requests: 0,
    failures: 0,
    ms: 0,
    rerunAfterDrop: 0,
    rerunAfterTruncate: 0,
  };

  try {
    run.tokensBefore = estimateRequestTokens(event);
    if (run.tokensBefore < state.config.thresholdTokens) {
      state.telemetry.trace(
        `below threshold tokens=${run.tokensBefore} threshold=${state.config.thresholdTokens}`,
      );
      return;
    }

    const { messages: library, source } = toLibraryMessages(event.messages);
    const calls = collectToolCalls(library, state.config.preserveRecent);
    run.calls = calls.length;

    // Re-runs are attributed to earlier decisions BEFORE this run's own decisions are remembered.
    const reruns = state.telemetry.countReruns(event.sessionID, calls);
    run.rerunAfterDrop = reruns.rerunAfterDrop;
    run.rerunAfterTruncate = reruns.rerunAfterTruncate;

    const candidates = calls.filter(
      (call) => !call.pinned && !state.memo.has(call.tool_use_id),
    );

    if (candidates.length > 0) {
      const fitted = fitState(library, calls, {
        goal: "",
        maxStateTokens: state.config.maxStateTokens,
        preserveRecentMessages: state.config.preserveRecent,
      });
      run.stage = fitted.stage;
      const batches = batchCalls(candidates, fitted.tokens, {
        maxRequestTokens: state.config.maxRequestTokens,
      });
      const allowed = reserveRequests(batches.length);
      if (allowed < batches.length) {
        warnOnce(
          "plugin:daily-cap",
          `fast-opencode-compaction: daily cap of ${DAILY_REQUEST_CAP} decision requests reached; ` +
            `${batches.length - allowed} of ${batches.length} batches skipped today — the cap resets on the next local day`,
        );
      }
      const asker = askerFor(state, event.sessionID);
      state.telemetry.trace(
        `candidates=${candidates.length} batches=${batches.length} allowed=${allowed}`,
      );

      for (const batch of batches.slice(0, allowed)) {
        try {
          const questions = Object.assign({}, ...batch.map((call) => questionsFor(call)));
          const answers = await asker.ask(fitted.state, questions);
          run.requests += 1;
          rememberAnswers(state, batch, answers);
        } catch (error) {
          run.failures += 1;
          state.telemetry.trace(`decision request failed: ${errorText(error)}`);
          warnOnce(
            "plugin:decision-failed",
            `fast-opencode-compaction: a decision request failed and the request was left untouched (${errorText(error)})`,
          );
          break;
        }
      }
    }

    // Always re-apply: the host does not persist our edits, so remembered decisions must be redone.
    const decisions = memoDecisions(state, calls);
    const applied = applyDecisions(event.messages, source, calls, decisions, TRUNCATE_HEAD_CHARS);
    state.telemetry.remember(event.sessionID, calls, decisions);
    run.dropped = applied.dropped;
    run.truncated = applied.truncated;

    run.tokensAfter =
      applied.dropped + applied.truncated > 0 ? estimateRequestTokens(event) : run.tokensBefore;
    run.tokensSaved = Math.max(0, run.tokensBefore - run.tokensAfter);
    state.telemetry.trace(
      `applied dropped=${run.dropped} truncated=${run.truncated} requests=${run.requests}`,
    );
  } catch (error) {
    run.failures += 1;
    state.telemetry.trace(`context hook failed: ${errorText(error)}`);
    warnOnce(
      "plugin:context-failed",
      `fast-opencode-compaction: the context hook failed and the request was left untouched (${errorText(error)})`,
    );
  } finally {
    run.ms = Date.now() - started;
    state.telemetry.record(event.sessionID, run);
  }
}

/**
 * The compaction request is a chance to explain the pruning to the model: results carrying the
 * truncation marker were shortened on purpose, so they are not evidence that a tool failed.
 */
function onCompaction(state: PluginState, event: SessionCompaction): void {
  const started = Date.now();
  let failures = 0;
  try {
    event.system.push({
      type: "text",
      text:
        "Some earlier tool results in this conversation were shortened by fast-opencode-compaction " +
        `to save context. They carry a "${TRUNCATION_PREFIX}…]" note and are not tool failures: ` +
        "re-run the tool if the full output is needed.",
    });
    state.telemetry.trace(`compaction note appended session=${event.sessionID}`);
  } catch (error) {
    failures = 1;
    warnOnce(
      "plugin:compaction-failed",
      `fast-opencode-compaction: the compaction note could not be added (${errorText(error)})`,
    );
  } finally {
    // The compaction hook prunes nothing, so this run never reaches the ledger: recording it just
    // keeps the counters honest about how often the note was delivered.
    state.telemetry.record(event.sessionID, {
      reason: "compaction",
      stage: "",
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      calls: 0,
      dropped: 0,
      truncated: 0,
      requests: 0,
      failures,
      ms: Date.now() - started,
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });
  }
}

/**
 * Registers the hooks unless no decision endpoint is configured, in which case the plugin stays off
 * and says so once. `enabled: false` is the deliberate off switch: no hooks and no warning at all.
 * `setup` runs once per process, so the memo and the counters live here.
 */
export async function setup(ctx: Plugin.Context): Promise<void> {
  const options = (ctx.options ?? {}) as ProviderConfig;
  // Captured once: key lookups read this snapshot instead of re-reading `process.env` per request.
  const env = process.env;
  const config = resolveProviderConfig(options, env);
  if (!config) {
    // Only a genuinely unconfigured plugin warns; a disabled one is silent by design.
    if (options.enabled !== false) {
      warnOnce(
        "plugin:not-configured",
        "fast-opencode-compaction: no decision endpoint configured (set TYPESAFE_API_KEY or OPENCODE_API_KEY, or pass a provider option); the plugin stays off",
      );
    }
    return;
  }

  const state: PluginState = {
    config,
    env,
    askers: new Map(),
    memo: new Map(),
    telemetry: createTelemetry(stateDirectory(), Date.now, {
      provider: config.provider,
      model: config.model,
    }),
  };

  await ctx.session.hook("context", (event) => onContext(state, event));
  await ctx.session.hook("compaction", (event) => onCompaction(state, event));
}
