/**
 * Plugin integration tests (task 06): the real hooks against a local `node:http` decision endpoint.
 *
 * No external network: the endpoint binds 127.0.0.1 and answers whatever questions it is asked. The
 * daily usage file is redirected into a temp dir per test, so the cap test is deterministic.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentPart, Message as V2Message } from "@opencode/ai";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./plugin.js";

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model?: string;
    state?: unknown;
    questions?: Record<string, unknown>;
  };
}

/** Answers every question with the same probability, keyed by the question's role. */
type Answerer = (questions: Record<string, unknown>) => Record<string, unknown>;

const answers = (keepCall: number, keepResult: number): Answerer => (questions) =>
  Object.fromEntries(
    Object.keys(questions).map((name) => [
      name,
      { type: "noul", noul: name.startsWith("call_") ? keepCall : keepResult },
    ]),
  );

const servers: Server[] = [];
let stateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "fast-opencode-compaction-test-"));
  previousStateDir = process.env.FAST_OPENCODE_COMPACTION_STATE_DIR;
  process.env.FAST_OPENCODE_COMPACTION_STATE_DIR = stateDir;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.FAST_OPENCODE_COMPACTION_STATE_DIR;
  else process.env.FAST_OPENCODE_COMPACTION_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startEndpoint(answer: Answerer, status = 200) {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += String(chunk)));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as RecordedRequest["body"];
      requests.push({
        url: request.url ?? "",
        headers: request.headers as Record<string, string>,
        body,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        status === 200
          ? JSON.stringify({ model: body.model, answers: answer(body.questions ?? {}) })
          : JSON.stringify({ error: { type: "server_error", message: "endpoint exploded" } }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { requests, baseUrl: `http://127.0.0.1:${port}/v1/systemone` };
}

/** Plugin options that always engage: threshold 1 token. */
function pluginOptions(baseUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "custom",
    baseUrl,
    model: "test-model",
    apiKey: "test-key",
    timeoutMs: 5_000,
    thresholdTokens: 1,
    preserveRecent: 0,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
    ...overrides,
  };
}

type Hook = (event: unknown) => unknown;

function fakeContext(options: Record<string, unknown>) {
  const hooks: Record<string, Hook> = {};
  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof setup>[0], hooks };
}

function v2(role: V2Message["role"], content: ContentPart[]): V2Message {
  return { role, content } as unknown as V2Message;
}

const text = (value: string): ContentPart => ({ type: "text", text: value });
const toolCall = (id: string, name: string, input: unknown): ContentPart =>
  ({ type: "tool-call", id, name, input }) as ContentPart;
const toolResult = (id: string, name: string, value: string): ContentPart =>
  ({ type: "tool-result", id, name, result: { type: "text", value } }) as ContentPart;

function contextEvent(messages: V2Message[], sessionID = "ses_test"): SessionContext {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    system: [],
    messages,
    options: {},
    tools: {},
  } as unknown as SessionContext;
}

/** One call in a non-pinned message plus its result, big enough to matter. */
function fixture(callId = "call_1", sessionSuffix = ""): V2Message[] {
  return [
    v2("user", [text("please run it")]),
    v2("assistant", [text("running"), toolCall(callId, "bash", { command: "ls" })]),
    v2("tool", [toolResult(callId, "bash", `${callId}${sessionSuffix}${"z".repeat(4_000)}`)]),
  ];
}

/** Pairing invariant: every call id in the request has its result, and vice versa. */
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

describe("plugin setup", () => {
  it("stays silent when disabled through options: no hooks and no warning", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("OPENCODE_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, hooks } = fakeContext({ enabled: false });

    await setup(ctx);

    expect(hooks.context).toBeUndefined();
    expect(hooks.compaction).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays off and says so when no provider is configured", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("OPENCODE_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, hooks } = fakeContext({});

    await setup(ctx);

    expect(hooks.context).toBeUndefined();
    expect(hooks.compaction).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("no decision endpoint configured");
  });
});

describe("context hook", () => {
  it("does nothing below the engage threshold", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl, { thresholdTokens: 1_000_000 }));
    await setup(ctx);
    const event = contextEvent(fixture());

    await hooks.context(event);

    expect(endpoint.requests).toHaveLength(0);
    expect(event.messages).toHaveLength(3);
    assertPaired(event.messages);
  });

  it("prunes above the threshold, keeps pairing, and sends the session header", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl));
    await setup(ctx);
    const event = contextEvent(fixture());

    await hooks.context(event);

    expect(endpoint.requests).toHaveLength(1);
    const request = endpoint.requests[0];
    expect(request.url).toBe("/v1/systemone");
    expect(request.body.model).toBe("test-model");
    expect(Object.keys(request.body.questions ?? {}).sort()).toEqual(["call_t1", "result_t1"]);
    expect(request.headers["x-opencode-session"]).toBe("ses_test");
    expect(request.headers["user-agent"]).toBe("fast-opencode-compaction/0.1");
    expect(request.headers.authorization).toBe("Bearer test-key");

    // Both the call and its result are gone, and the message that lost everything is removed.
    expect(event.messages).toHaveLength(2);
    expect(event.messages[1].content).toEqual([text("running")]);
    assertPaired(event.messages);
  });

  it("splits into one request per batch when the request budget is small", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(
      pluginOptions(endpoint.baseUrl, { maxStateTokens: 300, maxRequestTokens: 400 }),
    );
    await setup(ctx);
    const event = contextEvent([
      v2("user", [text("run all three")]),
      v2("assistant", [
        text("on it"),
        toolCall("call_1", "bash", { command: "true" }),
        toolCall("call_2", "bash", { command: "true" }),
        toolCall("call_3", "bash", { command: "true" }),
      ]),
      v2("tool", [
        toolResult("call_1", "bash", "one"),
        toolResult("call_2", "bash", "two"),
        toolResult("call_3", "bash", "three"),
      ]),
    ]);

    await hooks.context(event);

    expect(endpoint.requests.length).toBeGreaterThanOrEqual(2);
    // Every batch was decided, so all three calls are gone.
    expect(event.messages).toHaveLength(2);
    expect(event.messages[1].content).toEqual([text("on it")]);
    assertPaired(event.messages);
  });

  it("stops at the daily cap without touching the request", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl));
    await setup(ctx);

    await hooks.context(contextEvent(fixture("call_1")));
    expect(endpoint.requests).toHaveLength(1);

    const usagePath = join(stateDir, "usage.json");
    const usage = JSON.parse(readFileSync(usagePath, "utf8")) as { day: string; requests: number };
    expect(usage.requests).toBe(1);
    writeFileSync(usagePath, JSON.stringify({ day: usage.day, requests: 10_000 }));

    const capped = contextEvent(fixture("call_9"));
    const before = capped.messages.length;
    await hooks.context(capped);

    expect(endpoint.requests).toHaveLength(1); // the capped run sent nothing
    expect(capped.messages).toHaveLength(before); // and edited nothing
    assertPaired(capped.messages);
  });

  it("leaves the request untouched when the endpoint fails", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1), 500);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl));
    await setup(ctx);
    const event = contextEvent(fixture());
    const before = JSON.stringify(event.messages);

    await expect(hooks.context(event)).resolves.toBeUndefined();

    expect(endpoint.requests).toHaveLength(1);
    expect(JSON.stringify(event.messages)).toBe(before);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain("left untouched");
  });

  it("makes no new request for known calls but re-applies the memo", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl));
    await setup(ctx);

    const first = contextEvent(fixture());
    await hooks.context(first);
    expect(endpoint.requests).toHaveLength(1);
    expect(first.messages).toHaveLength(2);

    // The host does not persist our edits: the next call sees pristine messages again.
    const second = contextEvent(fixture("call_1"));
    await hooks.context(second);

    expect(endpoint.requests).toHaveLength(1); // all calls already decided
    expect(second.messages).toHaveLength(2); // but the remembered decisions were re-applied
    assertPaired(second.messages);
  });
});

describe("compaction hook", () => {
  it("notes that shortened results are deliberate, not tool failures", async () => {
    const endpoint = await startEndpoint(answers(0.1, 0.1));
    const { ctx, hooks } = fakeContext(pluginOptions(endpoint.baseUrl));
    await setup(ctx);

    const event = {
      sessionID: "ses_test",
      system: [{ type: "text", text: "you are a helpful assistant" }],
      messages: [],
      tools: {},
    };

    await hooks.compaction(event);

    expect(event.system).toHaveLength(2);
    const note = event.system[1];
    expect(note.type).toBe("text");
    expect(note.text).toContain("[fast-opencode-compaction truncated ");
    expect(note.text).toContain("not tool failures");
  });
});
