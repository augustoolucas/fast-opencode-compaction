/**
 * Adapter tests (task 04): V2 message shapes → library messages + source map.
 *
 * Fixtures are plain objects with the V2 runtime shape; V2 itself builds these with `Schema.make`,
 * and the adapter only reads properties, so a cast is enough (and keeps the fixtures readable).
 */

import { describe, expect, it } from "vitest";
import type { ContentPart, Message as V2Message } from "@opencode/ai";
import { callIdOf, resultTextOf, toLibraryMessages } from "./adapter.js";

function v2(role: V2Message["role"], content: ContentPart[]): V2Message {
  return { role, content } as unknown as V2Message;
}

type ToolResultValue = Extract<ContentPart, { type: "tool-result" }>["result"];

const text = (value: string): ContentPart => ({ type: "text", text: value });
const reasoning = (value: string): ContentPart => ({ type: "reasoning", text: value });
const media = (): ContentPart => ({ type: "media", mediaType: "image/png", data: "aGk=" });
const effort = (): ContentPart => ({ type: "effort" }) as ContentPart;
const toolCall = (id: string, name: string, input: unknown): ContentPart => ({
  type: "tool-call",
  id,
  name,
  input,
}) as ContentPart;
const toolResult = (id: string, name: string, result: ToolResultValue): ContentPart =>
  ({ type: "tool-result", id, name, result }) as ContentPart;

describe("toLibraryMessages", () => {
  it("maps a multi-part assistant turn and carries call ids verbatim", () => {
    const input = [
      v2("user", [text("  fix the build  ")]),
      v2("assistant", [
        reasoning("thinking about it"),
        text("I will look."),
        toolCall("call_1", "bash", { command: "npm test" }),
        toolCall("call_2", "read", { file: "a.ts" }),
      ]),
    ];

    const { messages, source } = toLibraryMessages(input);

    expect(messages).toEqual([
      { role: "user", text: "fix the build", toolUses: [] },
      {
        role: "assistant",
        text: "I will look.",
        toolUses: [
          { tool_use_id: "call_1", tool: "bash", input: { command: "npm test" } },
          { tool_use_id: "call_2", tool: "read", input: { file: "a.ts" } },
        ],
      },
    ]);

    expect(source).toHaveLength(input.length);
    expect(source[0]?.message).toBe(input[0]);
    expect(source[0]?.messageIndex).toBe(0);
    expect(source[1]?.messageIndex).toBe(1);
    expect([...source[1].callParts.keys()]).toEqual(["call_1", "call_2"]);
    expect(source[1].callParts.get("call_1")).toBe(input[1].content[2]);
    expect(source[1].resultParts.size).toBe(0);
    // The source keeps the live content array, which is what the apply step edits.
    expect(source[1].parts).toBe(input[1].content);
  });

  it("renders error, json and content results, and maps the tool role to user", () => {
    const input = [
      v2("tool", [toolResult("call_err", "bash", { type: "error", value: "command failed" })]),
      v2("tool", [toolResult("call_json", "read", { type: "json", value: { ok: true, n: 3 } })]),
      v2("tool", [
        toolResult("call_content", "fetch", {
          type: "content",
          value: [
            { type: "text", text: "line one" },
            { type: "file", uri: "file:///tmp/shot.png", mime: "image/png", name: "shot.png" },
          ],
        }),
      ]),
    ];

    const { messages } = toLibraryMessages(input);

    expect(messages[0]).toEqual({
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [{ tool_use_id: "call_err", text: "command failed", isError: true }],
    });
    expect(messages[1]?.toolResults).toEqual([
      { tool_use_id: "call_json", text: '{"ok":true,"n":3}', isError: false },
    ]);
    expect(messages[2]?.toolResults).toEqual([
      { tool_use_id: "call_content", text: "line one\n[file shot.png]", isError: false },
    ]);
  });

  it("keeps a call and its later result in their own entries, paired by id", () => {
    const input = [
      v2("assistant", [toolCall("call_9", "grep", { pattern: "x" })]),
      v2("tool", [toolResult("call_9", "grep", { type: "text", value: "match" })]),
    ];

    const { messages, source } = toLibraryMessages(input);

    expect(messages).toEqual([
      {
        role: "assistant",
        text: "",
        toolUses: [{ tool_use_id: "call_9", tool: "grep", input: { pattern: "x" } }],
      },
      {
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [{ tool_use_id: "call_9", text: "match", isError: false }],
      },
    ]);
    expect([...source[0].callParts.keys()]).toEqual(["call_9"]);
    expect(source[0].resultParts.size).toBe(0);
    expect(source[1].callParts.size).toBe(0);
    expect(source[1].resultParts.get("call_9")).toBe(input[1].content[0]);
    expect(source.map((entry) => entry.messageIndex)).toEqual([0, 1]);
  });

  it("drops messages that carry nothing but keeps their source entry", () => {
    const input = [
      v2("user", []),
      v2("assistant", [reasoning("only thinking")]),
      v2("user", [media()]),
      v2("user", [effort()]),
      v2("user", [text("real content")]),
    ];

    const { messages, source } = toLibraryMessages(input);

    expect(messages).toEqual([{ role: "user", text: "real content", toolUses: [] }]);
    // One source entry per input message: indices never desync.
    expect(source).toHaveLength(input.length);
    expect(source.map((entry) => entry.messageIndex)).toEqual([null, null, null, null, 0]);
    // Skipped parts are still reachable for the apply step, which must not touch them.
    expect(source[1].parts).toHaveLength(1);
    expect(source[1].parts[0]?.type).toBe("reasoning");
    expect(source[2].parts[0]?.type).toBe("media");
    expect(source[3].parts[0]?.type).toBe("effort");
  });

  it("skips system messages without leaking their text into the library view", () => {
    const input = [
      v2("system", [text("you are a helpful assistant")]),
      v2("user", [text("hi")]),
    ];

    const { messages, source } = toLibraryMessages(input);

    expect(messages).toEqual([{ role: "user", text: "hi", toolUses: [] }]);
    expect(source).toHaveLength(2);
    expect(source[0]?.messageIndex).toBeNull();
    expect(source[0].parts[0]?.type).toBe("text");
    expect(source[1]?.messageIndex).toBe(0);
  });

  it("tolerates missing content and non-object tool input", () => {
    const input = [
      { role: "user" } as unknown as V2Message,
      v2("assistant", [toolCall("call_prim", "fn", 42)]),
    ];

    const { messages, source } = toLibraryMessages(input);

    expect(messages).toEqual([
      {
        role: "assistant",
        text: "",
        toolUses: [{ tool_use_id: "call_prim", tool: "fn", input: { value: 42 } }],
      },
    ]);
    expect(source).toHaveLength(2);
    expect(source[0]?.messageIndex).toBeNull();
    expect(source[1]?.messageIndex).toBe(0);
    expect(toLibraryMessages([])).toEqual({ messages: [], source: [] });
  });
});

describe("part helpers", () => {
  it("reads call ids from call and result parts only", () => {
    expect(callIdOf(toolCall("call_1", "bash", {}))).toBe("call_1");
    expect(callIdOf(toolResult("call_1", "bash", { type: "text", value: "x" }))).toBe("call_1");
    expect(callIdOf(text("hello"))).toBeUndefined();
    expect(callIdOf(reasoning("hmm"))).toBeUndefined();
  });

  it("renders result text for every result type, falling back to the file uri", () => {
    expect(resultTextOf(text("hello"))).toBeUndefined();
    expect(resultTextOf(toolResult("c", "f", { type: "text", value: "plain" }))).toEqual({
      text: "plain",
      isError: false,
    });
    expect(resultTextOf(toolResult("c", "f", { type: "json", value: [1, 2] }))).toEqual({
      text: "[1,2]",
      isError: false,
    });
    expect(resultTextOf(toolResult("c", "f", { type: "text", value: 7 }))).toEqual({
      text: "7",
      isError: false,
    });
    expect(resultTextOf(toolResult("c", "f", { type: "error", value: "boom" }))).toEqual({
      text: "boom",
      isError: true,
    });
    expect(
      resultTextOf(
        toolResult("c", "f", {
          type: "content",
          value: [{ type: "file", uri: "file:///tmp/a.bin", mime: "application/octet-stream" }],
        }),
      ),
    ).toEqual({ text: "[file file:///tmp/a.bin]", isError: false });
  });
});
