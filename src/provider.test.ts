/**
 * Provider layer tests (task 03).
 *
 * No network and no real processes: `fetch` and `spawnSync` are injected. Environment variables are
 * stubbed per test, and key-resolution cases use distinct env var names and commands so the
 * per-process caches in `src/provider.ts` cannot leak between tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_DEFAULTS,
  ProviderRequestError,
  createAsker,
  createWarnOnce,
  describeProviderError,
  resolveApiKey,
  resolveProviderConfig,
  type ResolvedProviderConfig,
  type SpawnSyncLike,
} from "./provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A resolved config with test-friendly values; every field overridable. */
function resolved(overrides: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig {
  return {
    provider: "zen",
    baseUrl: "https://endpoint.test/v1/systemone",
    model: "jev-test",
    headers: {},
    timeoutMs: 1_000,
    thresholdTokens: 100,
    keepThreshold: 0.5,
    preserveRecent: 6,
    maxStateTokens: 900,
    maxRequestTokens: 1_200,
    enabled: true,
    ...overrides,
  };
}

type FetchCall = { url: string; init: RequestInit };
type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Records what the asker sent and answers with canned responses. */
function makeFetch(respond: Responder): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = init ?? {};
    calls.push({ url, init: request });
    return respond(url, request);
  };
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const noulQuestion = { type: "noul" as const, instructions: "should this stay?" };

describe("resolveProviderConfig", () => {
  it("uses the explicit provider even when the environment points elsewhere", () => {
    const config = resolveProviderConfig(
      { provider: "typesafe" },
      { OPENCODE_API_KEY: "zen-key", TYPESAFE_API_KEY: "typesafe-key" },
    );

    expect(config).toMatchObject({
      provider: "typesafe",
      baseUrl: PROVIDER_DEFAULTS.typesafe.baseUrl,
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      enabled: true,
    });
  });

  it("auto-detects typesafe first, then zen", () => {
    expect(resolveProviderConfig({}, { TYPESAFE_API_KEY: "a", OPENCODE_API_KEY: "b" })).toMatchObject({
      provider: "typesafe",
      model: "jev-latest",
      apiKeyEnv: "TYPESAFE_API_KEY",
    });

    expect(resolveProviderConfig({}, { OPENCODE_API_KEY: "b" })).toMatchObject({
      provider: "zen",
      baseUrl: PROVIDER_DEFAULTS.zen.baseUrl,
      model: "jev-1.13-free",
      apiKeyEnv: "OPENCODE_API_KEY",
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
    });
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolveProviderConfig({}, {})).toBeUndefined();
    expect(resolveProviderConfig()).toBeUndefined();
  });

  it("returns undefined when disabled", () => {
    expect(resolveProviderConfig({ enabled: false }, { OPENCODE_API_KEY: "b" })).toBeUndefined();
  });

  it("lets every field be overridden", () => {
    const config = resolveProviderConfig(
      {
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080/systemone",
        model: "laya",
        apiKey: "inline-key",
        apiKeyEnv: "CUSTOM_PROVIDER_KEY",
        apiKeyCommand: ["pass", "show", "custom"],
        headers: { "x-opencode-session": "ses_test" },
        timeoutMs: 1_234,
        thresholdTokens: 42,
        keepThreshold: 0.9,
        preserveRecent: 2,
        maxStateTokens: 111,
        maxRequestTokens: 222,
      },
      {},
    );

    expect(config).toEqual({
      provider: "custom",
      baseUrl: "http://127.0.0.1:8080/systemone",
      model: "laya",
      apiKey: "inline-key",
      apiKeyEnv: "CUSTOM_PROVIDER_KEY",
      apiKeyCommand: ["pass", "show", "custom"],
      headers: { "x-opencode-session": "ses_test" },
      timeoutMs: 1_234,
      thresholdTokens: 42,
      keepThreshold: 0.9,
      preserveRecent: 2,
      maxStateTokens: 111,
      maxRequestTokens: 222,
      enabled: true,
    });
  });

  it("keeps custom's small budgets by default", () => {
    const config = resolveProviderConfig(
      { provider: "custom", baseUrl: "http://127.0.0.1:8080", model: "laya" },
      {},
    );

    expect(config).toMatchObject({ maxStateTokens: 900, maxRequestTokens: 1_200, apiKeyEnv: undefined });
  });

  it("refuses an incomplete custom provider and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveProviderConfig({ provider: "custom" }, {})).toBeUndefined();
    expect(resolveProviderConfig({ provider: "custom", baseUrl: "http://127.0.0.1:8080" }, {})).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("needs both baseUrl and model");
  });
});

describe("resolveApiKey", () => {
  it("prefers the explicit key over env and command", () => {
    vi.stubEnv("PROBE_KEY_OPTION", "from-env");
    const spawn = vi.fn<SpawnSyncLike>(() => ({ status: 0, stdout: "from-command\n" }));

    const key = resolveApiKey(
      {
        provider: "custom",
        apiKey: "from-option",
        apiKeyEnv: "PROBE_KEY_OPTION",
        apiKeyCommand: ["probe-option"],
      },
      spawn,
    );

    expect(key).toBe("from-option");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("prefers the env var over the command", () => {
    vi.stubEnv("PROBE_KEY_ENV", "from-env");
    const spawn = vi.fn<SpawnSyncLike>(() => ({ status: 0, stdout: "from-command\n" }));

    const key = resolveApiKey(
      { provider: "custom", apiKeyEnv: "PROBE_KEY_ENV", apiKeyCommand: ["probe-env"] },
      spawn,
    );

    expect(key).toBe("from-env");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the command without a shell, trims stdout, and caches the result per process", () => {
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const spawn: SpawnSyncLike = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "  cmd-key\n" };
    };
    const config = { provider: "custom" as const, apiKeyCommand: ["pass", "show", "probe-cache"] };

    expect(resolveApiKey(config, spawn)).toBe("cmd-key");
    expect(resolveApiKey(config, spawn)).toBe("cmd-key");

    expect(calls).toEqual([
      { command: "pass", args: ["show", "probe-cache"], options: { timeout: 3_000, encoding: "utf8" } },
    ]);
  });

  it("returns undefined when the command fails, prints nothing, or throws", () => {
    const fail = (suffix: string): { provider: "custom"; apiKeyCommand: string[] } => ({
      provider: "custom",
      apiKeyCommand: ["probe-fail", suffix],
    });

    expect(resolveApiKey(fail("status"), () => ({ status: 1, stdout: "nope" }))).toBeUndefined();
    expect(resolveApiKey(fail("null-status"), () => ({ status: null, stdout: "nope" }))).toBeUndefined();
    expect(resolveApiKey(fail("blank"), () => ({ status: 0, stdout: "   \n" }))).toBeUndefined();
    expect(resolveApiKey(fail("error"), () => ({ status: null, error: new Error("ENOENT") }))).toBeUndefined();
    expect(
      resolveApiKey(fail("throws"), () => {
        throw new Error("spawn exploded");
      }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is configured and does not spawn", () => {
    const spawn = vi.fn<SpawnSyncLike>(() => ({ status: 0, stdout: "never" }));

    expect(resolveApiKey({ provider: "custom" }, spawn)).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reads the key from the configured environment variable", () => {
    vi.stubEnv("PROBE_KEY_ONLY", "env-only-key");

    expect(resolveApiKey({ provider: "custom", apiKeyEnv: "PROBE_KEY_ONLY" })).toBe("env-only-key");
  });
});

describe("describeProviderError", () => {
  it("classifies key, funds, model and transport failures", () => {
    expect(describeProviderError(401, "unauthorized").kind).toBe("auth");
    expect(describeProviderError(403, "forbidden").kind).toBe("auth");
    expect(describeProviderError(402, "Insufficient account funds").kind).toBe("funds");
    expect(describeProviderError(400, 'Upstream request failed: "Model is unavailable."').kind).toBe("model");
    expect(describeProviderError(400, "some other complaint").kind).toBe("transport");
    expect(describeProviderError(429, "slow down").kind).toBe("transport");
    expect(describeProviderError(503, "").kind).toBe("transport");
  });

  it("returns a single-line, length-bounded, actionable message", () => {
    const info = describeProviderError(401, `line one\nline two ${"x".repeat(500)}`);

    expect(info).toMatchObject({ kind: "auth", status: 401 });
    expect(info.message).toContain("HTTP 401");
    expect(info.message).toContain("apiKeyEnv");
    expect(info.message).not.toContain("\n");
    expect(info.message).not.toContain("x".repeat(201));
    expect(info.message).toContain("line one line two");
  });

  it("says so when the endpoint sent no body", () => {
    expect(describeProviderError(500, "   ").message).toContain("(empty body)");
  });
});

describe("createAsker", () => {
  it("sends the upstream request shape with session header, UA and answers parsing", async () => {
    const { impl, calls } = makeFetch(() =>
      jsonResponse({
        model: "jev-test",
        answers: { call_t1: { type: "noul", noul: 0.95 } },
        usage: { input_tokens: 12, output_tokens: 2 },
        routing: { ignored: true },
      }),
    );
    const asker = createAsker(
      resolved({ apiKey: "key-123", headers: { "x-opencode-session": "ses_test" } }),
      impl,
    );

    const answers = await asker.ask({ context: "state" }, { call_t1: noulQuestion });

    expect(answers).toEqual({ call_t1: { type: "noul", noul: 0.95 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://endpoint.test/v1/systemone");

    const init = calls[0]?.init ?? {};
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "jev-test",
      state: { context: "state" },
      questions: { call_t1: noulQuestion },
    });

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer key-123");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-opencode-session"]).toBe("ses_test");
    expect(headers["user-agent"]).toBe("fast-opencode-compaction/0.1");
  });

  it("takes the key from the environment and lets the UA be overridden", async () => {
    vi.stubEnv("PROBE_ASKER_KEY", "asker-env-key");
    const { impl, calls } = makeFetch(() => jsonResponse({ answers: {} }));
    const asker = createAsker(resolved({ apiKeyEnv: "PROBE_ASKER_KEY", headers: { "User-Agent": "custom/9" } }), impl);

    await asker.ask("state", {});

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer asker-env-key");
    expect(headers["User-Agent"]).toBe("custom/9");
    expect(headers["user-agent"]).toBeUndefined();
  });

  it("uses an empty key when none is configured instead of failing early", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = makeFetch(() => textResponse('{"error":{"type":"unauthorized"}}', 401));

    await expect(createAsker(resolved({ baseUrl: "https://endpoint.test/no-key" }), impl).ask({}, {})).rejects.toMatchObject(
      { kind: "auth", status: 401 },
    );

    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer ");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("apiKeyEnv");
  });

  it("classifies a 402, throws a typed error and warns once per endpoint and kind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = makeFetch(() =>
      textResponse('{"error":{"type":"server_error","message":"Insufficient account funds"}}', 402),
    );
    const asker = createAsker(
      resolved({ apiKey: "k", baseUrl: "https://endpoint.test/funds" }),
      impl,
    );

    const first = await asker.ask({}, {}).catch((error: unknown) => error);
    const second = await asker.ask({}, {}).catch((error: unknown) => error);

    expect(first).toBeInstanceOf(ProviderRequestError);
    expect(first).toMatchObject({ kind: "funds", status: 402 });
    expect((first as Error).message).toContain("insufficient funds");
    expect((first as Error).message).toContain("Insufficient account funds");
    expect(second).toMatchObject({ kind: "funds" });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("classifies a 400 model rejection as a model problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = makeFetch(() =>
      textResponse('{"error":{"type":"invalid_request","message":"Model is unavailable."}}', 400),
    );

    await expect(
      createAsker(resolved({ apiKey: "k", baseUrl: "https://endpoint.test/model" }), impl).ask({}, {}),
    ).rejects.toMatchObject({ kind: "model", status: 400 });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("check the model option");
  });

  it("surfaces malformed JSON and missing answers", async () => {
    const malformed = makeFetch(() => textResponse("<html>not json</html>", 200));
    await expect(
      createAsker(resolved({ apiKey: "k", baseUrl: "https://endpoint.test/malformed" }), malformed.impl).ask({}, {}),
    ).rejects.toThrow(/malformed JSON/i);

    const noAnswers = makeFetch(() => jsonResponse({ model: "jev-test" }));
    await expect(
      createAsker(resolved({ apiKey: "k", baseUrl: "https://endpoint.test/no-answers" }), noAnswers.impl).ask({}, {}),
    ).rejects.toThrow(/missing answers/i);
  });

  it("aborts a slow endpoint after timeoutMs", async () => {
    let sawAbort = false;
    const { impl } = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(signal.reason);
          });
        }),
    );

    await expect(
      createAsker(resolved({ apiKey: "k", timeoutMs: 5, baseUrl: "https://endpoint.test/slow" }), impl).ask({}, {}),
    ).rejects.toBeDefined();

    expect(sawAbort).toBe(true);
  });
});

describe("createWarnOnce", () => {
  it("fires once per key and again for a different key", () => {
    const emit = vi.fn<(message: string) => void>();
    const warn = createWarnOnce(emit);

    warn("provider:auth", "first");
    warn("provider:auth", "again");
    warn("provider:funds", "second");

    expect(emit.mock.calls.map(([message]) => message)).toEqual(["first", "second"]);
  });

  it("never lets a throwing emitter escape", () => {
    const warn = createWarnOnce(() => {
      throw new Error("logger exploded");
    });

    expect(() => warn("key", "message")).not.toThrow();
  });
});
