/**
 * V2 hook probe (spike, task 02).
 *
 * Purpose: record what the opencode V2 plugin API actually does before product code depends on it.
 * Writes one JSON line per hook call to `spike/hook-probe/.opencode/logs/probe.jsonl` — counts and
 * lengths only, never message content.
 *
 * Questions this file exists to answer:
 *   a) does the plugin load and does `setup` run?
 *   b) does `context` fire once per model call, and what are `system`/`tools`?
 *   c) do mutations of the hook event persist into later calls?
 *   d) is a V1-style hook object returned from `setup` ever invoked?
 *   e) which export form and which config form does the loader accept?
 *
 * Nothing here may throw out of a hook: every handler is wrapped so a broken probe cannot break a
 * session. See ../README.md for how to run it and ../../docs/spike-v2-hooks.md for the findings.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Appended to the first text part on the first `context` call, then looked for on later calls. */
const MARKER = " [[probe-marker]]";

/** `spike/hook-probe/.opencode/logs/probe.jsonl`, resolved from this file, not from the cwd. */
function resolveLogFile(): string {
  try {
    return fileURLToPath(new URL("../logs/probe.jsonl", import.meta.url));
  } catch {
    return ".opencode/logs/probe.jsonl";
  }
}

const LOG_FILE = resolveLogFile();

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Append one evidence line. Never throws. */
function log(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry });
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* a probe that breaks the host is worse than a probe with no evidence */
  }
}

type Part = { type?: unknown; text?: unknown };
type MessageLike = { role?: unknown; content?: unknown };

function messagesOf(event: unknown): MessageLike[] {
  const messages = (event as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) ? (messages as MessageLike[]) : [];
}

function partsOf(message: MessageLike): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}

function isTextPart(part: Part): boolean {
  return part.type === "text" && typeof part.text === "string";
}

/** First text part across all messages, or undefined. */
function firstTextPart(messages: MessageLike[]): Part | undefined {
  for (const message of messages) {
    for (const part of partsOf(message)) {
      if (isTextPart(part)) return part;
    }
  }
  return undefined;
}

function markerPresent(messages: MessageLike[]): boolean {
  return messages.some((message) =>
    partsOf(message).some((part) => isTextPart(part) && String(part.text).includes(MARKER)),
  );
}

/** The counts-only shape every log line carries. */
function summarize(event: unknown): Record<string, unknown> {
  const messages = messagesOf(event);
  const system = (event as { system?: unknown } | null)?.system;
  const tools = (event as { tools?: unknown } | null)?.tools;
  const first = firstTextPart(messages);

  return {
    sessionID: (event as { sessionID?: unknown } | null)?.sessionID ?? null,
    messages: messages.length,
    parts: messages.reduce((total, message) => total + partsOf(message).length, 0),
    system: {
      present: Array.isArray(system),
      count: Array.isArray(system) ? system.length : 0,
      chars: Array.isArray(system)
        ? system.reduce<number>(
            (total, part) =>
              total + (typeof (part as Part)?.text === "string" ? String((part as Part).text).length : 0),
            0,
          )
        : 0,
    },
    tools: {
      present: tools !== null && typeof tools === "object",
      count: tools !== null && typeof tools === "object" ? Object.keys(tools as object).length : 0,
    },
    firstTextLen: first ? String(first.text).length : null,
  };
}

function nullCounts(): Record<string, unknown> {
  return { sessionID: null, messages: null, parts: null, system: null, tools: null, firstTextLen: null };
}

let contextCalls = 0;

/** context: fires per model call; mutates on the first call, then reports whether the marker stuck. */
function onContext(event: unknown): void {
  try {
    contextCalls += 1;
    const messages = messagesOf(event);
    const alreadyMarked = markerPresent(messages);
    const target = firstTextPart(messages);
    const lenBefore = target ? String(target.text).length : null;
    let mutated = false;
    let lenAfter = lenBefore;
    let mutationError: string | null = null;

    if (contextCalls === 1 && target && !alreadyMarked) {
      try {
        target.text = `${String(target.text)}${MARKER}`;
        mutated = true;
        lenAfter = String(target.text).length;
      } catch (error) {
        mutationError = errorText(error);
      }
    }

    log({
      ...summarize(event),
      hook: "context",
      contextCall: contextCalls,
      markerPresent: alreadyMarked,
      mutated,
      lenBefore,
      lenAfter,
      ...(mutationError ? { mutationError } : {}),
    });
  } catch (error) {
    log({ ...nullCounts(), hook: "context.error", error: errorText(error) });
  }
}

/** compaction: does not mutate; records whether a compaction result is already set. */
function onCompaction(event: unknown): void {
  try {
    log({
      ...summarize(event),
      hook: "compaction",
      resultSet: (event as { result?: unknown } | null)?.result !== undefined,
    });
  } catch (error) {
    log({ ...nullCounts(), hook: "compaction.error", error: errorText(error) });
  }
}

/**
 * V1 compatibility probe: `setup` returns a valid cleanup function (V2 contract) that also carries
 * the V1 hook names as own properties, so a loader that reads the return value as a hook map has
 * something to invoke — and never gets a non-callable object it might blindly call.
 */
function createCleanup(): unknown {
  const v1Hooks = {
    "experimental.chat.messages.transform": (input: unknown) => {
      try {
        log({ ...summarize(input), hook: "v1.experimental.chat.messages.transform" });
      } catch (error) {
        log({ ...nullCounts(), hook: "v1.error", error: errorText(error) });
      }
    },
    "experimental.session.compacting": (input: unknown) => {
      try {
        log({ ...summarize(input), hook: "v1.experimental.session.compacting" });
      } catch (error) {
        log({ ...nullCounts(), hook: "v1.error", error: errorText(error) });
      }
    },
  };

  return Object.assign(() => {
    log({ ...nullCounts(), hook: "cleanup" });
  }, v1Hooks);
}

async function setup(ctx: unknown): Promise<unknown> {
  const context = ctx as { session?: { hook?: unknown }; options?: unknown } | null;

  log({
    ...nullCounts(),
    hook: "setup.start",
    pluginID: "hook-probe",
    logFile: LOG_FILE,
    sessionHookType: typeof context?.session?.hook,
    contextKeys:
      context !== null && typeof context === "object" ? Object.keys(context).sort() : null,
    options: context?.options ?? null,
  });

  let registered = 0;
  try {
    const hook = context?.session?.hook;
    if (typeof hook !== "function") {
      throw new Error(`ctx.session.hook is ${typeof hook}`);
    }
    await (hook as (name: string, callback: unknown) => Promise<unknown>)("context", onContext);
    registered += 1;
    await (hook as (name: string, callback: unknown) => Promise<unknown>)("compaction", onCompaction);
    registered += 1;
  } catch (error) {
    log({ ...nullCounts(), hook: "setup.error", error: errorText(error), registered });
    return;
  }

  log({ ...nullCounts(), hook: "setup", pluginID: "hook-probe", registered });

  return createCleanup();
}

export default { id: "hook-probe", setup };
