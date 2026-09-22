/**
 * Telemetry (task 07): what was removed, what it cost, and whether the model had to re-run a tool we
 * pruned.
 *
 * Three files, all under the state directory:
 * - `ledger.jsonl` — append-only, one line per run that changed the request, size-rotated at 5 MB to
 *   `ledger.jsonl.1`. Counts, lengths and ids only: no message content, no tool results, no keys.
 * - `stats.json` — cumulative counters, flushed at most once a minute and merged into whatever the
 *   file already holds, so a restart does not lose history.
 * - `debug.log` — verbose trace, only with `FAST_OPENCODE_COMPACTION_DEBUG=1`.
 *
 * Nothing here may throw: a telemetry failure must never affect the outgoing request. Failures are
 * reported once through `warnOnce` and then swallowed.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { warnOnce } from "./provider.js";

/** Overrides where the state directory lives. */
export const STATE_DIR_ENV = "FAST_OPENCODE_COMPACTION_STATE_DIR";

/** Debug tracing toggle; anything but "1" keeps the trace file from being written. */
export const DEBUG_ENV = "FAST_OPENCODE_COMPACTION_DEBUG";

const LEDGER_FILE = "ledger.jsonl";
const LEDGER_ROTATED_FILE = "ledger.jsonl.1";
const STATS_FILE = "stats.json";
const DEBUG_FILE = "debug.log";

/** Rotate the ledger once it grows past this (single generation, one rotated file). */
const LEDGER_MAX_BYTES = 5 * 1024 * 1024;

/** Counters are written to `stats.json` at most this often. */
const FLUSH_INTERVAL_MS = 60_000;

/** How many sessions' pruned signatures are remembered before the whole map is dropped. */
const MAX_SESSIONS = 200;

/**
 * Home of the persistent state (usage cap, ledger, counters, debug log). One implementation, shared
 * with the plugin.
 */
export function stateDirectory(): string {
  return (
    process.env[STATE_DIR_ENV] ||
    join(homedir(), ".local", "share", "opencode", "fast-opencode-compaction")
  );
}

/** One run's numbers, as handed to `record`. */
export interface RunRecord {
  /** Why the run happened: `step` for a model call, `compaction` for a compaction request. */
  reason: string;
  /** Last fitting stage the state needed (`fitState`), empty when no state was built. */
  stage: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  calls: number;
  dropped: number;
  truncated: number;
  requests: number;
  ms: number;
  rerunAfterDrop: number;
  rerunAfterTruncate: number;
}

/** Cumulative counters, as stored in `stats.json`. */
export interface Counters {
  runs: number;
  /** Runs that actually changed the request (the ones that got a ledger line). */
  changed: number;
  calls: number;
  dropped: number;
  truncated: number;
  requests: number;
  rerunAfterDrop: number;
  rerunAfterTruncate: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  ms: number;
}

/** The rerun tallies of one run. */
export interface RerunTally {
  rerunAfterDrop: number;
  rerunAfterTruncate: number;
}

/** The sliver of a library tool call telemetry looks at. */
export interface TelemetryCall {
  /** The library's short call id, as it appears in decisions. */
  readonly id: string;
  /** The V2 call id the adapter carried verbatim. */
  readonly tool_use_id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/** The sliver of a library decision telemetry looks at. */
export interface TelemetryDecision {
  readonly action: string;
  /** The library's short call id (`TelemetryCall.id`). */
  readonly id: string;
}

/** Who produced a run: the resolved provider preset and the model it points at. */
export interface TelemetryIdentity {
  readonly provider: string;
  readonly model: string;
}

/** Fallback identity when a caller does not name one; the plugin always does. */
const UNKNOWN_IDENTITY: TelemetryIdentity = { provider: "unknown", model: "unknown" };

/** Per-provider bucket in `stats.json`, keyed `"<provider>:<model>"`. */
export interface ProviderBucket {
  runs: number;
  changed: number;
  dropped: number;
  truncated: number;
  requests: number;
  tokensSaved: number;
  rerunAfterDrop: number;
  rerunAfterTruncate: number;
}

function bucketZeros(): ProviderBucket {
  return {
    runs: 0,
    changed: 0,
    dropped: 0,
    truncated: 0,
    requests: 0,
    tokensSaved: 0,
    rerunAfterDrop: 0,
    rerunAfterTruncate: 0,
  };
}

/** Adds a bucket's worth of numbers onto a copy of `target`; junk values count as zero. */
function addBucket(target: ProviderBucket, delta: Partial<ProviderBucket>): ProviderBucket {
  const merged = { ...target };
  for (const key of Object.keys(merged) as Array<keyof ProviderBucket>) {
    const value = delta[key];
    merged[key] += typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
  return merged;
}

/** What the plugin needs from telemetry. */
export interface Telemetry {
  /** Counts re-runs of calls pruned earlier. Call this BEFORE applying this run's decisions. */
  countReruns(session: string, calls: readonly TelemetryCall[]): RerunTally;
  /** Remembers the calls this run dropped or truncated, so a re-run can be attributed later. */
  remember(session: string, calls: readonly TelemetryCall[], decisions: readonly TelemetryDecision[]): void;
  /** Counts the run and appends a ledger line when it changed the request. */
  record(session: string, run: RunRecord): void;
  /** Writes one debug line when tracing is on. */
  trace(message: string): void;
  /** Writes the counters out now, regardless of the minute interval. */
  flush(): void;
}

/** Stable identity of a tool call: the tool plus its input, kept in memory only. */
export function callSignature(call: Pick<TelemetryCall, "tool" | "input">): string {
  let input: string;
  try {
    input = JSON.stringify(call.input ?? {});
  } catch {
    input = "";
  }
  return `${call.tool}\u0000${input}`;
}

function zeros(): Counters {
  return {
    runs: 0,
    changed: 0,
    calls: 0,
    dropped: 0,
    truncated: 0,
    requests: 0,
    rerunAfterDrop: 0,
    rerunAfterTruncate: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    ms: 0,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Builds a telemetry recorder. Injectable directory and clock keep it testable. */
export function createTelemetry(
  directory: string = stateDirectory(),
  nowMs: () => number = Date.now,
  identity: TelemetryIdentity = UNKNOWN_IDENTITY,
): Telemetry {
  const ledgerPath = join(directory, LEDGER_FILE);
  const rotatedPath = join(directory, LEDGER_ROTATED_FILE);
  const statsPath = join(directory, STATS_FILE);
  const debugPath = join(directory, DEBUG_FILE);
  /** The bucket every record lands in, in `stats.json`. */
  const bucketKey = `${identity.provider}:${identity.model}`;

  /** Deltas since the last flush, and when that flush happened. */
  let pending = zeros();
  let pendingByProvider = new Map<string, ProviderBucket>();
  let lastFlushMs = 0;

  /** Per session: the signatures of the calls this plugin dropped or truncated, by call id. */
  const prunes = new Map<string, { dropped: Map<string, string>; truncated: Map<string, string> }>();

  function sessionPrunes(session: string): { dropped: Map<string, string>; truncated: Map<string, string> } {
    let entry = prunes.get(session);
    if (!entry) {
      // Bound the map: past the limit the oldest attributions go, like the reference port does.
      if (prunes.size >= MAX_SESSIONS) prunes.clear();
      entry = { dropped: new Map(), truncated: new Map() };
      prunes.set(session, entry);
    }
    return entry;
  }

  function fail(error: unknown): void {
    warnOnce("telemetry:failed", `fast-opencode-compaction: telemetry failed (${errorText(error)})`);
  }

  /** Appends one line, rotating first when the ledger outgrew its cap. */
  function appendLedger(line: string): void {
    mkdirSync(directory, { recursive: true });
    try {
      if (statSync(ledgerPath).size >= LEDGER_MAX_BYTES) renameSync(ledgerPath, rotatedPath);
    } catch {
      // no ledger yet: nothing to rotate
    }
    appendFileSync(ledgerPath, `${line}\n`);
  }

  /** Adds the pending deltas to whatever `stats.json` already holds and writes it back. */
  function writeCounters(): void {
    mkdirSync(directory, { recursive: true });

    let existing: Partial<Counters> = {};
    let existingBuckets: Record<string, Partial<ProviderBucket>> = {};
    try {
      const parsed = JSON.parse(readFileSync(statsPath, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        existing = parsed as Partial<Counters>;
        const buckets = (parsed as { byProvider?: unknown }).byProvider;
        if (buckets !== null && typeof buckets === "object") {
          existingBuckets = buckets as Record<string, Partial<ProviderBucket>>;
        }
      }
    } catch {
      // missing or unreadable: this flush starts from zero
    }

    const merged: Record<string, number> = {};
    for (const [key, value] of Object.entries(pending) as Array<[keyof Counters, number]>) {
      const previous = existing[key];
      merged[key] = (typeof previous === "number" && Number.isFinite(previous) ? previous : 0) + value;
    }

    // Per-provider buckets merge the same way: what the file holds, plus this process's deltas.
    const byProvider: Record<string, ProviderBucket> = {};
    for (const [key, bucket] of Object.entries(existingBuckets)) {
      if (bucket !== null && typeof bucket === "object") byProvider[key] = addBucket(bucketZeros(), bucket);
    }
    for (const [key, delta] of pendingByProvider) {
      byProvider[key] = addBucket(byProvider[key] ?? bucketZeros(), delta);
    }

    const temp = `${statsPath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({ ...merged, byProvider, updatedAt: new Date(nowMs()).toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temp, statsPath);
  }

  return {
    countReruns(session: string, calls: readonly TelemetryCall[]): RerunTally {
      const tally: RerunTally = { rerunAfterDrop: 0, rerunAfterTruncate: 0 };
      try {
        const entry = prunes.get(session);
        if (!entry) return tally;

        for (const call of calls) {
          const signature = callSignature(call);

          const droppedUnder = entry.dropped.get(signature);
          if (droppedUnder !== undefined) {
            if (droppedUnder !== call.tool_use_id) {
              tally.rerunAfterDrop += 1;
              // Remember the new id so the same re-run is not counted again on the next request.
              entry.dropped.set(signature, call.tool_use_id);
            }
            continue;
          }

          const truncatedUnder = entry.truncated.get(signature);
          if (truncatedUnder !== undefined && truncatedUnder !== call.tool_use_id) {
            tally.rerunAfterTruncate += 1;
            entry.truncated.set(signature, call.tool_use_id);
          }
        }
      } catch (error) {
        fail(error);
      }
      return tally;
    },

    remember(session: string, calls: readonly TelemetryCall[], decisions: readonly TelemetryDecision[]): void {
      try {
        const entry = sessionPrunes(session);
        const byId = new Map(calls.map((call) => [call.id, call]));

        for (const decision of decisions) {
          if (decision.action !== "drop_call" && decision.action !== "drop_result") continue;
          const call = byId.get(decision.id);
          if (!call) continue;
          const target = decision.action === "drop_call" ? entry.dropped : entry.truncated;
          target.set(callSignature(call), call.tool_use_id);
        }
      } catch (error) {
        fail(error);
      }
    },

    record(session: string, run: RunRecord): void {
      try {
        const changed = run.dropped + run.truncated > 0;

        pending.runs += 1;
        pending.calls += run.calls;
        pending.dropped += run.dropped;
        pending.truncated += run.truncated;
        pending.requests += run.requests;
        pending.rerunAfterDrop += run.rerunAfterDrop;
        pending.rerunAfterTruncate += run.rerunAfterTruncate;
        pending.tokensBefore += run.tokensBefore;
        pending.tokensAfter += run.tokensAfter;
        pending.tokensSaved += run.tokensSaved;
        pending.ms += run.ms;
        if (changed) pending.changed += 1;

        pendingByProvider.set(
          bucketKey,
          addBucket(pendingByProvider.get(bucketKey) ?? bucketZeros(), {
            runs: 1,
            changed: changed ? 1 : 0,
            dropped: run.dropped,
            truncated: run.truncated,
            requests: run.requests,
            tokensSaved: run.tokensSaved,
            rerunAfterDrop: run.rerunAfterDrop,
            rerunAfterTruncate: run.rerunAfterTruncate,
          }),
        );

        if (changed) {
          appendLedger(
            JSON.stringify({
              at: new Date(nowMs()).toISOString(),
              session,
              // Who produced this line; the plugin passes the resolved identity at creation.
              provider: identity.provider,
              model: identity.model,
              reason: run.reason,
              stage: run.stage,
              tokensBefore: run.tokensBefore,
              tokensAfter: run.tokensAfter,
              tokensSaved: run.tokensSaved,
              calls: run.calls,
              dropped: run.dropped,
              truncated: run.truncated,
              requests: run.requests,
              ms: run.ms,
              rerunAfterDrop: run.rerunAfterDrop,
              rerunAfterTruncate: run.rerunAfterTruncate,
            }),
          );
        }

        // First record flushes immediately; after that, at most once a minute.
        const stamp = nowMs();
        if (lastFlushMs === 0 || stamp - lastFlushMs >= FLUSH_INTERVAL_MS) {
          writeCounters();
          pending = zeros();
          pendingByProvider = new Map();
          lastFlushMs = stamp;
        }
      } catch (error) {
        fail(error);
      }
    },

    trace(message: string): void {
      try {
        if (process.env[DEBUG_ENV] !== "1") return;
        mkdirSync(directory, { recursive: true });
        appendFileSync(debugPath, `${new Date(nowMs()).toISOString()} ${message}\n`);
      } catch (error) {
        fail(error);
      }
    },

    flush(): void {
      try {
        writeCounters();
        pending = zeros();
        pendingByProvider = new Map();
        lastFlushMs = nowMs();
      } catch (error) {
        fail(error);
      }
    },
  };
}
