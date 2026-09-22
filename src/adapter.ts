/**
 * Adapter (task 04): V2 request messages → the compaction library's `Message` shape, plus the source
 * map the apply step needs to edit the original parts.
 *
 * Two views are returned and they are deliberately different:
 *
 * - `messages` is the library shape, built for `collectToolCalls`/`fitState`. The library's
 *   `ToolCall.callIndex`/`resultIndex` index THIS array.
 * - `source` has one entry per **input** message, in input order — including messages that produced
 *   no library message (nothing to compact: reasoning-only, media-only, empty, or `system`). Keeping
 *   the source view complete is what stops indices from drifting: the apply step can rebuild the
 *   outgoing request from it, and `SourceEntry.messageIndex` links each input message to its library
 *   message (`null` when it was dropped).
 *
 * Roles: the library only knows `user`/`assistant`, and tool results live in `user` messages — the
 * V2 `tool` role maps to `user`, `assistant` stays `assistant`, and `system` messages are skipped
 * (the hook carries `system` separately).
 */

import type { ContentPart, Message as V2Message } from "@opencode/ai";
import type { Message, Role, ToolResult, ToolUse } from "fast-jev-compaction";

/** Call id of a V2 `tool-call`/`tool-result` part; `undefined` for any other part. */
export function callIdOf(part: ContentPart): string | undefined {
  return part.type === "tool-call" || part.type === "tool-result" ? part.id : undefined;
}

/** A tool result rendered to text, with the error flag the library expects. */
export interface ResultText {
  readonly text: string;
  readonly isError: boolean;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Non-text entries of a `content` result: files keep a readable placeholder. */
function renderContentEntry(entry: { type: "text"; text: string } | { type: "file"; uri: string; name?: string }): string {
  return entry.type === "text" ? entry.text : `[file ${entry.name ?? entry.uri}]`;
}

/**
 * Body of a V2 `tool-result` part as text, and whether the result is an error. `undefined` when the
 * part is not a tool result. Also used by the apply step, which re-renders truncated bodies.
 */
export function resultTextOf(part: ContentPart): ResultText | undefined {
  if (part.type !== "tool-result") return undefined;

  switch (part.result.type) {
    case "text":
    case "json":
      return { text: stringifyValue(part.result.value), isError: false };
    case "error":
      return { text: stringifyValue(part.result.value), isError: true };
    case "content":
      return {
        text: part.result.value.map((entry) => renderContentEntry(entry)).join("\n"),
        isError: false,
      };
  }
}

/** Tool input as the library wants it: an object, wrapping anything else so nothing is lost. */
function asInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

/** One input message and the live V2 objects of its tool traffic. */
export interface SourceEntry {
  /** The V2 message, untouched. */
  readonly message: V2Message;
  /**
   * The message's content array — the same array instance the message holds, so the apply step can
   * splice parts out of it and have the change land on the request. (V2 types declare `content`
   * readonly; the hook hands over live objects and task-02 showed in-place edits take effect.)
   */
  readonly parts: ContentPart[];
  /** V2 `tool-call` parts of this message, keyed by the call id carried verbatim from V2. */
  readonly callParts: Map<string, ContentPart>;
  /** V2 `tool-result` parts of this message, keyed by the same call ids. */
  readonly resultParts: Map<string, ContentPart>;
  /** Index of this message in `messages`, or `null` when the message was dropped. */
  readonly messageIndex: number | null;
}

/** The library view and the source view of one request's messages. */
export interface AdaptedMessages {
  messages: Message[];
  source: SourceEntry[];
}

/**
 * Converts one request's V2 messages. Never throws on odd input: unknown part types are skipped,
 * malformed content arrays are treated as empty, and a message that yields no text and no tool parts
 * is dropped from `messages` while keeping its `SourceEntry`.
 */
export function toLibraryMessages(messages: readonly V2Message[]): AdaptedMessages {
  const library: Message[] = [];
  const source: SourceEntry[] = [];

  for (const message of messages ?? []) {
    const parts = Array.isArray(message?.content) ? (message.content as ContentPart[]) : [];
    const callParts = new Map<string, ContentPart>();
    const resultParts = new Map<string, ContentPart>();
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];

    if (message?.role !== "system") {
      for (const part of parts) {
        switch (part.type) {
          case "text":
            texts.push(part.text);
            break;
          case "tool-call":
            callParts.set(part.id, part);
            toolUses.push({ tool_use_id: part.id, tool: part.name, input: asInput(part.input) });
            break;
          case "tool-result": {
            const result = resultTextOf(part);
            if (!result) break;
            resultParts.set(part.id, part);
            toolResults.push({ tool_use_id: part.id, text: result.text, isError: result.isError });
            break;
          }
          default:
            // `reasoning` and `media` are out of scope: the decision state never needs them and the
            // apply step must leave them untouched.
            break;
        }
      }
    }

    const text = texts.join("\n").trim();
    const role: Role = message?.role === "assistant" ? "assistant" : "user";
    const kept = message?.role !== "system" && (text.length > 0 || toolUses.length > 0 || toolResults.length > 0);

    if (!kept) {
      source.push({ message, parts, callParts, resultParts, messageIndex: null });
      continue;
    }

    const libraryMessage: Message = { role, text, toolUses };
    if (toolResults.length > 0) libraryMessage.toolResults = toolResults;

    source.push({
      message,
      parts,
      callParts,
      resultParts,
      messageIndex: library.length,
    });
    library.push(libraryMessage);
  }

  return { messages: library, source };
}
