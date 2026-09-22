/**
 * Apply tests: decisions → edits on V2 parts, with pairing invariants held.
 *
 * Calls and decisions come from the real library (`collectToolCalls` + `decideCall`) so the id
 * translation this module depends on — decision id `t1` → `tool_use_id` `call_1` → source map — is
 * exercised end to end rather than hand-faked.
 */

import { decideCall, collectToolCalls } from "fast-jev-compaction";
import type { CallAnswer, CallDecision, ToolCall } from "fast-jev-compaction";
import type { ContentPart, Message as V2Message, ToolResultPart } from "@opencode/ai";
import { describe, expect, it } from "vitest";
import { toLibraryMessages } from "./adapter.js";
import { applyDecisions } from "./apply.js";

const KEEP_THRESHOLD = { keepThreshold: 0.5 };
const DROP_BOTH: CallAnswer = { keepCall: 0, keepResult: 0 };
const DROP_RESULT: CallAnswer = { keepCall: 0.9, keepResult: 0.1 };

function v2(role: V2Message["role"], content: ContentPart[]): V2Message {
  return { role, content } as unknown as V2Message;
}

type ToolResultValue = Extract<ContentPart, { type: "tool-result" }>["result"];

const text = (value: string): ContentPart => ({ type: "text", text: value });
const reasoning = (value: string): ContentPart => ({ type: "reasoning", text: value });
const toolCall = (id: string, name: string, input: unknown): ContentPart =>
  ({ type: "tool-call", id, name, input }) as ContentPart;
const toolResult = (id: string, name: string, result: ToolResultValue): ContentPart =>
  ({ type: "tool-result", id, name, result }) as ContentPart;

/** The library assigns its own short ids (`t1`…) and keeps the V2 id in `tool_use_id`. */
function callsOf(input: readonly V2Message[], preserveRecent = 0): ToolCall[] {
  return collectToolCalls(toLibraryMessages(input).messages, preserveRecent);
}

const dropCall = (call: ToolCall): CallDecision => decideCall(call, DROP_BOTH, KEEP_THRESHOLD);
const dropResult = (call: ToolCall): CallDecision => decideCall(call, DROP_RESULT, KEEP_THRESHOLD);

function toolResultPartOf(message: V2Message, index = 0): ToolResultPart {
  const part: ContentPart | undefined = message.content[index];
  if (!part || part.type !== "tool-result") throw new Error("fixture expected a tool-result part");
  return part;
}

/** Pairing invariant: every call id in the request has its result, and every result has its call. */
function assertPaired(messages: readonly V2Message[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.id);
      if (part.type === "tool-result") results.add(part.id);
    }
  }
  expect([...calls].sort()).toEqual([...results].sort());
}

describe("applyDecisions", () => {
  it("drops a call together with a result that lives in a later message", () => {
    const input = [
      v2("user", [text("please run the tests")]),
      v2("assistant", [text("running"), toolCall("call_1", "bash", { command: "npm test" })]),
      v2("tool", [toolResult("call_1", "bash", { type: "text", value: "all good" })]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    const resultMessage = input[2];
    const applied = applyDecisions(input, source, calls, [dropCall(calls[0])], 300);

    expect(applied).toEqual({ dropped: 1, truncated: 0 });
    expect(input).toHaveLength(2); // the message that lost everything is gone
    expect(resultMessage.content).toHaveLength(0);
    expect(input[1].content).toEqual([text("running")]); // the text part stays
    assertPaired(input);

    // The source map keeps every input message, removed ones included, so it never desyncs.
    expect(source).toHaveLength(3);
    expect(source[2].parts).toBe(resultMessage.content);
    expect(source[2].messageIndex).toBe(2);
  });

  it("truncates a result body with the head and the note", () => {
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [toolCall("call_1", "bash", {})]),
      v2("tool", [toolResult("call_1", "bash", { type: "text", value: "x".repeat(500) })]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    const applied = applyDecisions(input, source, calls, [dropResult(calls[0])], 10);

    expect(applied).toEqual({ dropped: 0, truncated: 1 });
    const part = toolResultPartOf(input[2]);
    expect(part.result.type).toBe("text");
    expect(part.result.value).toBe(
      `xxxxxxxxxx\n[fast-opencode-compaction truncated 490 chars of this tool result; re-run the tool if needed]`,
    );
    expect(input).toHaveLength(3); // the message still carries the shortened result
    assertPaired(input);
  });

  it("keeps only the note when headChars is 0", () => {
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [toolCall("call_1", "bash", {})]),
      v2("tool", [toolResult("call_1", "bash", { type: "text", value: "y".repeat(120) })]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    applyDecisions(input, source, calls, [dropResult(calls[0])], 0);

    expect(toolResultPartOf(input[2]).result.value).toBe(
      "[fast-opencode-compaction truncated 120 chars of this tool result; re-run the tool if needed]",
    );
  });

  it("does nothing when the head already covers the body", () => {
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [toolCall("call_1", "bash", {})]),
      v2("tool", [toolResult("call_1", "bash", { type: "text", value: "short" })]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    expect(applyDecisions(input, source, calls, [dropResult(calls[0])], 1_000)).toEqual({
      dropped: 0,
      truncated: 0,
    });
    expect(toolResultPartOf(input[2]).result.value).toBe("short");
  });

  it("never touches a pinned call, even if a decision asks for it", () => {
    const input = [
      v2("assistant", [toolCall("call_pin", "bash", {})]),
      v2("tool", [toolResult("call_pin", "bash", { type: "text", value: "pinned output" })]),
      v2("user", [text("a later turn")]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input, 2);
    expect(calls[0].pinned).toBe(true);

    const libraryDecision = dropCall(calls[0]);
    expect(libraryDecision).toMatchObject({ action: "keep", reason: "pinned" });
    const forced: CallDecision = { ...libraryDecision, action: "drop_call", reason: "call_dropped" };

    const before = JSON.stringify(input);
    expect(applyDecisions(input, source, calls, [libraryDecision, forced], 0)).toEqual({
      dropped: 0,
      truncated: 0,
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(input).toHaveLength(3);
  });

  it("mixes actions in one message and leaves text and reasoning parts untouched", () => {
    const reasoningPart = reasoning("thinking");
    const textPart = text("done");
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [reasoningPart, textPart, toolCall("call_a", "bash", {}), toolCall("call_b", "read", {})]),
      v2("tool", [
        toolResult("call_a", "bash", { type: "text", value: "A".repeat(50) }),
        toolResult("call_b", "read", { type: "text", value: "B".repeat(50) }),
      ]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    const applied = applyDecisions(input, source, calls, [dropCall(calls[0]), dropResult(calls[1])], 5);

    expect(applied).toEqual({ dropped: 1, truncated: 1 });
    expect(input).toHaveLength(3); // neither message lost everything
    expect(input[1].content[0]).toBe(reasoningPart); // identity: never rewritten
    expect(input[1].content[1]).toBe(textPart);
    expect(input[1].content.map((part) => part.type)).toEqual(["reasoning", "text", "tool-call"]);

    const remainingCall = input[1].content[2];
    if (remainingCall.type !== "tool-call") throw new Error("expected the kept tool-call part");
    expect(remainingCall.id).toBe("call_b");

    expect(input[2].content).toHaveLength(1);
    const kept = toolResultPartOf(input[2]);
    expect(kept.id).toBe("call_b");
    expect(kept.result.value).toBe(
      `BBBBB\n[fast-opencode-compaction truncated 45 chars of this tool result; re-run the tool if needed]`,
    );
    assertPaired(input);
  });

  it("keeps content, json and error results schema-valid", () => {
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [
        toolCall("call_c", "fetch", {}),
        toolCall("call_j", "read", {}),
        toolCall("call_e", "bash", {}),
      ]),
      v2("tool", [
        toolResult("call_c", "fetch", {
          type: "content",
          value: [
            { type: "text", text: "hello world" },
            { type: "file", uri: "file:///tmp/a.png", mime: "image/png", name: "a.png" },
          ],
        }),
        toolResult("call_j", "read", { type: "json", value: { ok: true, n: 42 } }),
        toolResult("call_e", "bash", { type: "error", value: "boom happened" }),
      ]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);

    expect(applyDecisions(input, source, calls, calls.map(dropResult), 5)).toEqual({
      dropped: 0,
      truncated: 3,
    });

    const [content, json, error] = [
      toolResultPartOf(input[2], 0),
      toolResultPartOf(input[2], 1),
      toolResultPartOf(input[2], 2),
    ];

    expect(content.result.type).toBe("content");
    expect(content.result.value).toEqual([
      {
        type: "text",
        text: "hello\n[fast-opencode-compaction truncated 19 chars of this tool result; re-run the tool if needed]",
      },
    ]);

    expect(json.result.type).toBe("json");
    expect(json.result.value).toBe(
      `{"ok"\n[fast-opencode-compaction truncated 13 chars of this tool result; re-run the tool if needed]`,
    );

    expect(error.result.type).toBe("error"); // errors stay errors
    expect(error.result.value).toBe(
      `boom \n[fast-opencode-compaction truncated 8 chars of this tool result; re-run the tool if needed]`,
    );
    assertPaired(input);
  });

  it("is idempotent: a second pass changes nothing", () => {
    const input = [
      v2("user", [text("go")]),
      v2("assistant", [toolCall("call_1", "bash", {})]),
      v2("tool", [toolResult("call_1", "bash", { type: "text", value: "z".repeat(100) })]),
    ];
    const { source } = toLibraryMessages(input);
    const calls = callsOf(input);
    const decisions = [dropResult(calls[0])];

    expect(applyDecisions(input, source, calls, decisions, 10)).toEqual({ dropped: 0, truncated: 1 });
    const afterFirst = toolResultPartOf(input[2]).result.value;
    expect(applyDecisions(input, source, calls, decisions, 10)).toEqual({ dropped: 0, truncated: 0 });
    expect(toolResultPartOf(input[2]).result.value).toBe(afterFirst);
    expect(String(afterFirst).match(/fast-opencode-compaction truncated/g)).toHaveLength(1);

    const dropInput = [
      v2("user", [text("go")]),
      v2("assistant", [toolCall("call_2", "bash", {})]),
      v2("tool", [toolResult("call_2", "bash", { type: "text", value: "gone" })]),
    ];
    const dropSource = toLibraryMessages(dropInput).source;
    const dropCalls = callsOf(dropInput);
    const dropDecisions = [dropCall(dropCalls[0])];

    expect(applyDecisions(dropInput, dropSource, dropCalls, dropDecisions, 10)).toEqual({
      dropped: 1,
      truncated: 0,
    });
    expect(applyDecisions(dropInput, dropSource, dropCalls, dropDecisions, 10)).toEqual({
      dropped: 0,
      truncated: 0,
    });
    // Both the call-only assistant message and the result message lost everything.
    expect(dropInput).toHaveLength(1);
    assertPaired(dropInput);
  });

  it("keeps messages that were already empty and ignores unknown decisions", () => {
    const input = [v2("user", []), v2("user", [text("hi")])];
    const { source } = toLibraryMessages(input);
    const unknown: CallDecision = {
      id: "t99",
      tool: "bash",
      keepCall: 0,
      keepResult: 0,
      action: "drop_call",
      reason: "call_dropped",
    };

    expect(applyDecisions(input, source, [], [unknown], 10)).toEqual({ dropped: 0, truncated: 0 });
    expect(input).toHaveLength(2);
    expect(input[1].content).toEqual([text("hi")]);
  });
});
