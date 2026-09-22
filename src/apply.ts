/**
 * Apply step: turn library `CallDecision`s into edits on the outgoing V2 request.
 *
 * The hook spike established that editing the hook's messages affects only the request being built
 * and does NOT persist into the session, so this module edits in place: parts are spliced out of
 * `SourceEntry.parts` — the same array the V2 message holds — and messages that lose all their parts
 * are spliced out of the request array. V2 types declare parts readonly, hence the narrow mutable
 * views; the hook hands over live objects, which is what makes the edits land.
 *
 * Parts are found through `calls[].tool_use_id` (the id the adapter carried verbatim from V2) and the
 * source maps, never through index arithmetic, so a call and its result may sit in different
 * messages.
 */

import type { ContentPart, Message as V2Message, ToolResultPart } from "@opencode/ai";
import type { CallDecision, ToolCall } from "fast-jev-compaction";
import { resultTextOf, type SourceEntry } from "./adapter.js";

/**
 * Marker of an already-shortened result. Also the token the plugin's compaction note points at, so
 * it lives here as the single source of truth.
 */
export const TRUNCATION_PREFIX = "[fast-opencode-compaction truncated ";

/** What one apply pass did, for telemetry. */
export interface ApplyResult {
  /** Calls dropped: `drop_call` decisions that actually removed a part. */
  dropped: number;
  /** Results truncated: `drop_result` decisions that actually rewrote a body. */
  truncated: number;
}

function truncationNote(removed: number): string {
  return `${TRUNCATION_PREFIX}${removed} chars of this tool result; re-run the tool if needed]`;
}

/** One part with the message (and its live content array) it belongs to. */
interface LocatedPart {
  readonly entry: SourceEntry;
  readonly part: ContentPart;
}

function locate(
  source: readonly SourceEntry[],
  pick: (entry: SourceEntry) => Map<string, ContentPart>,
): Map<string, LocatedPart> {
  const located = new Map<string, LocatedPart>();
  for (const entry of source) {
    for (const [id, part] of pick(entry)) located.set(id, { entry, part });
  }
  return located;
}

/** Splices the part out of its message. `false` when it is already gone (idempotent second pass). */
function removePart(target: LocatedPart | undefined): boolean {
  if (!target) return false;
  const index = target.entry.parts.indexOf(target.part);
  if (index < 0) return false;
  target.entry.parts.splice(index, 1);
  return true;
}

/** V2 parts are typed readonly; this is the one place the mutable view is used on purpose. */
function setResultValue(part: ToolResultPart, value: unknown): void {
  (part.result as unknown as { value: unknown }).value = value;
}

/**
 * Shortens one result body in place, keeping the part schema-valid: `text`/`json`/`error` keep their
 * `type` and get the shortened string as `value`, `content` gets a single text entry. Returns whether
 * the body changed — a body that already carries the note, or one the head already covers, is left
 * alone.
 */
function truncateResult(part: ContentPart, headChars: number): boolean {
  if (part.type !== "tool-result") return false;

  const rendered = resultTextOf(part)?.text ?? "";
  if (rendered.length === 0 || rendered.includes(TRUNCATION_PREFIX)) return false;

  const head = headChars > 0 ? rendered.slice(0, headChars) : "";
  const removed = rendered.length - head.length;
  if (removed === 0) return false;

  const note = truncationNote(removed);
  const body = head.length > 0 ? `${head}\n${note}` : note;

  setResultValue(part, part.result.type === "content" ? [{ type: "text", text: body }] : body);
  return true;
}

/**
 * Applies decisions to `messages` (the outgoing V2 request array, edited in place) using the adapter's
 * `source` map and the library's `calls`. Pinned calls are never touched, `text`/`reasoning`/`media`
 * parts are never touched, and messages that only turn empty because of these edits are removed from
 * the request while the original order is kept. Applying the same decisions twice changes nothing
 * the second time.
 */
export function applyDecisions(
  messages: V2Message[],
  source: readonly SourceEntry[],
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  headChars: number,
): ApplyResult {
  const head = headChars > 0 && Number.isFinite(headChars) ? Math.floor(headChars) : 0;
  const callsById = new Map<string, ToolCall>(calls.map((call) => [call.id, call]));
  const callParts = locate(source, (entry) => entry.callParts);
  const resultParts = locate(source, (entry) => entry.resultParts);

  // Messages that already arrived without parts are not ours to remove; only ones this pass empties.
  const hadParts = new Set<SourceEntry>();
  for (const entry of source) if (entry.parts.length > 0) hadParts.add(entry);

  let dropped = 0;
  let truncated = 0;

  for (const decision of decisions) {
    const call = callsById.get(decision.id);
    if (call?.pinned === true || decision.reason === "pinned") continue;

    const toolUseId = call?.tool_use_id ?? decision.id;
    if (toolUseId.length === 0) continue;

    if (decision.action === "drop_call") {
      const removedCall = removePart(callParts.get(toolUseId));
      const removedResult = removePart(resultParts.get(toolUseId));
      if (removedCall || removedResult) dropped += 1;
    } else if (decision.action === "drop_result") {
      const target = resultParts.get(toolUseId);
      if (target && truncateResult(target.part, head)) truncated += 1;
    }
  }

  const emptied = new Set<V2Message>();
  for (const entry of source) {
    if (hadParts.has(entry) && entry.parts.length === 0) emptied.add(entry.message);
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && emptied.has(message)) messages.splice(index, 1);
  }

  return { dropped, truncated };
}
