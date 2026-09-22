/**
 * Provider layer.
 *
 * Resolves a typed-decision endpoint from plugin options and the environment, and exposes it as a
 * single `ask(state, questions)` function. The wire format itself is owned upstream by
 * `fast-jev-compaction` (`buildJevRequest` / `parseJevResponse`); this module only adds
 * configuration, transport, per-provider budgets and error classification.
 *
 * This file must never import `@opencode/plugin` at runtime: that package is a types-only
 * devDependency and the host resolves plugin dependencies from its own cache.
 */

import { spawnSync } from "node:child_process";
import type { JevAnswer, JevQuestion, JevResponse, JevState } from "fast-jev-compaction";
import { buildJevRequest, parseJevResponse } from "fast-jev-compaction";

/** One question the endpoint has to answer about the conversation state. */
export type DecisionQuestion = JevQuestion;
/** One answer, as the endpoint returns it; `DecisionAnswers` keys it by question name. */
export type DecisionAnswer = JevAnswer;
/** The `answers` envelope of a decision response — the only part of it that is validated. */
export type DecisionAnswers = JevResponse["answers"];
/** What the endpoint reasons over: a string or any JSON-serialisable object. */
export type DecisionState = JevState;

/** The one function the rest of the plugin needs from a provider. */
export interface DecisionAsker {
  ask(state: DecisionState, questions: Record<string, DecisionQuestion>): Promise<DecisionAnswers>;
}

/** Provider names, used to pick defaults; nothing downstream branches on them. */
export type ProviderName = "typesafe" | "zen" | "openrouter" | "vercel" | "custom";

/** Endpoint, model and budget defaults for one provider. */
export interface ProviderDefaults {
  readonly baseUrl: string;
  readonly model: string;
  /** Environment variable consulted when `apiKey` is not set; empty means "no default". */
  readonly apiKeyEnv: string;
  /**
   * Estimated request tokens below which the plugin does not engage. Big-context providers keep it
   * high: every engagement costs a decision request and invalidates the provider's prompt cache, so
   * it has to buy more than a round trip.
   */
  readonly thresholdTokens: number;
  /** Token ceiling for the state sent with a decision request. */
  readonly maxStateTokens: number;
  /** Token ceiling for state plus one batch of questions. */
  readonly maxRequestTokens: number;
}

/** Known endpoints. `custom` deliberately has no `baseUrl`/`model`: both must be provided. */
export const PROVIDER_DEFAULTS: Record<ProviderName, ProviderDefaults> = {
  typesafe: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY",
    thresholdTokens: 60_000,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  zen: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13-free",
    apiKeyEnv: "OPENCODE_API_KEY",
    thresholdTokens: 60_000,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  // Aggregator routes that speak System One. Endpoint constants come from PanAchy/jevvy (MIT),
  // packages/core/src/{openrouter,vercel}.ts; both authenticate with `Authorization: Bearer`, which
  // is our default. Untested live here: we have no key for either.
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    apiKeyEnv: "OPENROUTER_API_KEY",
    thresholdTokens: 60_000,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  vercel: {
    baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    thresholdTokens: 60_000,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  custom: {
    baseUrl: "",
    model: "",
    apiKeyEnv: "",
    thresholdTokens: 20_000,
    maxStateTokens: 900,
    maxRequestTokens: 1_200,
  },
};

/** Defaults for the knobs `PROVIDER_DEFAULTS` does not pin. All overridable per plugin options. */
const OPTION_DEFAULTS = {
  /**
   * The decision request runs inside a pre-request hook, so a hung endpoint must not hold a model
   * call for long.
   */
  timeoutMs: 20_000,
  /** Matches `fast-jev-compaction`'s own defaults. */
  keepThreshold: 0.5,
  /** Matches `fast-jev-compaction`'s own defaults. */
  preserveRecent: 6,
} as const;

/** What a caller may set in plugin options. Every field is optional. */
export interface ProviderConfig {
  /** Explicit provider; without it the environment is auto-detected. */
  provider?: ProviderName;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Environment variable to read the key from; defaults per provider. */
  apiKeyEnv?: string;
  /** argv of a command whose stdout is the key, run without a shell (3s timeout). */
  apiKeyCommand?: string[];
  /**
   * Extra headers merged into every request. Per-call values ride here, e.g.
   * `x-opencode-session`; `user-agent` can be overridden here as well.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  thresholdTokens?: number;
  keepThreshold?: number;
  preserveRecent?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  /** `false` makes `resolveProviderConfig` return `undefined`, so the provider never runs. */
  enabled?: boolean;
}

/**
 * Every key `ProviderConfig` understands. Anything else in the options object is a typo
 * (`thresholdToken`) or a wrapper's own metadata, and `warnUnknownOptionKeys` names it once.
 */
const KNOWN_OPTION_KEYS = [
  "provider",
  "baseUrl",
  "model",
  "apiKey",
  "apiKeyEnv",
  "apiKeyCommand",
  "headers",
  "timeoutMs",
  "thresholdTokens",
  "keepThreshold",
  "preserveRecent",
  "maxStateTokens",
  "maxRequestTokens",
  "enabled",
] as const;

type KnownOptionKey = (typeof KNOWN_OPTION_KEYS)[number];

/** Compile-time guard: the list above must stay in step with `ProviderConfig`. */
type AssertKeysComplete<T extends never> = T;
type OptionKeysComplete = AssertKeysComplete<Exclude<keyof ProviderConfig, KnownOptionKey>>;

/** A `ProviderConfig` with every field resolved to a value. */
export interface ResolvedProviderConfig {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyCommand?: string[];
  headers: Record<string, string>;
  timeoutMs: number;
  thresholdTokens: number;
  keepThreshold: number;
  preserveRecent: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  /** Always `true`: `enabled: false` resolves to `undefined` instead of a disabled config. */
  enabled: true;
}

/** Emits at most one message per key, for the lifetime of the emitter. */
export type WarnOnce = (key: string, message: string) => void;

/** Builds a `WarnOnce`. Tests pass a fake emitter; the plugin uses the process-wide one. */
export function createWarnOnce(emit: (message: string) => void = consoleWarn): WarnOnce {
  const seen = new Set<string>();
  return (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    try {
      emit(message);
    } catch {
      // a warning must never break a hook
    }
  };
}

/** Process-wide emitter for provider and configuration problems: one message per key. */
export const warnOnce: WarnOnce = createWarnOnce();

function consoleWarn(message: string): void {
  console.warn(message);
}

/** Auto-detection order: TypeSafe first, then the OpenCode Zen free tier. */
function detectProvider(env: Record<string, string | undefined>): ProviderName | undefined {
  if (env.TYPESAFE_API_KEY) return "typesafe";
  if (env.OPENCODE_API_KEY) return "zen";
  return undefined;
}

/**
 * Warns once about option keys we do not know, sorted and comma-separated. The target is a typo such
 * as `thresholdToken`, which would otherwise fall back to a default in silence.
 *
 * Choice: every unknown key **with a defined value** warns. A key set to `undefined` is not a
 * configuration attempt, and a wrapper shim passing its own metadata is named once for the life of
 * the process — a small price for never missing a typo, which is the failure mode this closes.
 * Resolution is never affected.
 */
function warnUnknownOptionKeys(options: ProviderConfig): void {
  const unknown = Object.keys(options ?? {})
    .filter((key) => (options as Record<string, unknown>)[key] !== undefined)
    .filter((key) => !KNOWN_OPTION_KEYS.includes(key as KnownOptionKey))
    .sort();

  if (unknown.length === 0) return;

  warnOnce(
    "provider:unknown-option",
    `fast-opencode-compaction: ignoring unknown option ${
      unknown.length === 1 ? "key" : "keys"
    } ${unknown.join(", ")} — check for typos`,
  );
}

/**
 * Resolves the endpoint to use, or `undefined` when there is nothing to use: no explicit provider
 * and no known key in the environment, `enabled: false`, or a `custom` provider that is missing its
 * required `baseUrl`/`model` (that last case is also reported through `warnOnce`).
 *
 * Unknown option keys are reported once, before anything else, unless the plugin is switched off —
 * `enabled: false` is meant to be a completely quiet off switch.
 */
export function resolveProviderConfig(
  options: ProviderConfig = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedProviderConfig | undefined {
  if (options.enabled === false) return undefined;

  warnUnknownOptionKeys(options);

  const provider = options.provider ?? detectProvider(env);
  if (!provider) return undefined;

  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl = options.baseUrl ?? defaults.baseUrl;
  const model = options.model ?? defaults.model;

  if (!baseUrl || !model) {
    warnOnce(
      `config:${provider}`,
      `fast-opencode-compaction: the ${provider} provider needs both baseUrl and model; it stays off`,
    );
    return undefined;
  }

  return {
    provider,
    baseUrl,
    model,
    apiKey: options.apiKey,
    apiKeyEnv: (options.apiKeyEnv ?? defaults.apiKeyEnv) || undefined,
    apiKeyCommand: options.apiKeyCommand,
    headers: { ...options.headers },
    timeoutMs: options.timeoutMs ?? OPTION_DEFAULTS.timeoutMs,
    thresholdTokens: options.thresholdTokens ?? defaults.thresholdTokens,
    keepThreshold: options.keepThreshold ?? OPTION_DEFAULTS.keepThreshold,
    preserveRecent: options.preserveRecent ?? OPTION_DEFAULTS.preserveRecent,
    maxStateTokens: options.maxStateTokens ?? defaults.maxStateTokens,
    maxRequestTokens: options.maxRequestTokens ?? defaults.maxRequestTokens,
    enabled: true,
  };
}

/** Minimal shape of `spawnSync` this module needs; injectable so tests never spawn anything. */
export type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: { timeout: number; encoding: "utf8" },
) => { status: number | null; stdout?: string | null; error?: unknown };

const spawnSyncLike: SpawnSyncLike = (command, args, options) => spawnSync(command, args, options);

/** A key-resolution command may hang; never let it hold a model call for longer than this. */
const API_KEY_COMMAND_TIMEOUT_MS = 3_000;

/** Which configs have already been resolved, so a command runs at most once per process. */
const apiKeyCache = new Map<string, string>();

function runApiKeyCommand(command: readonly string[], spawn: SpawnSyncLike): string | undefined {
  const [bin, ...args] = command;
  if (!bin) return undefined;
  try {
    const result = spawn(bin, args, { timeout: API_KEY_COMMAND_TIMEOUT_MS, encoding: "utf8" });
    if (result.error || result.status !== 0) return undefined;
    const value = (result.stdout ?? "").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the API key for a provider config: explicit `apiKey`, then its `apiKeyEnv` variable, then
 * its `apiKeyCommand`. Successful lookups are cached per process, so a command runs at most once.
 * Returns `undefined` when nothing yields a key — callers decide whether that is fatal.
 */
export function resolveApiKey(
  config: Pick<ProviderConfig, "provider" | "apiKey" | "apiKeyEnv" | "apiKeyCommand">,
  spawn: SpawnSyncLike = spawnSyncLike,
): string | undefined {
  if (config.apiKey) return config.apiKey;

  const cacheKey = JSON.stringify([
    config.provider ?? "",
    config.apiKeyEnv ?? "",
    config.apiKeyCommand ?? [],
  ]);
  const cached = apiKeyCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fromEnv = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (fromEnv) {
    apiKeyCache.set(cacheKey, fromEnv);
    return fromEnv;
  }

  const fromCommand = config.apiKeyCommand?.length
    ? runApiKeyCommand(config.apiKeyCommand, spawn)
    : undefined;
  if (fromCommand) {
    apiKeyCache.set(cacheKey, fromCommand);
    return fromCommand;
  }

  return undefined;
}

/** How a failed decision request is classified, so callers can warn, retry or disable. */
export type ProviderErrorKind = "auth" | "funds" | "model" | "transport";

/** A classified provider failure: the kind, the HTTP status, and a ready-to-print message. */
export interface ProviderErrorInfo {
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly message: string;
}

/** Thrown by `ask` for a non-2xx response, so callers can branch on `kind` instead of parsing text. */
export class ProviderRequestError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number;

  constructor(info: ProviderErrorInfo) {
    super(info.message);
    this.name = "ProviderRequestError";
    this.kind = info.kind;
    this.status = info.status;
  }
}

/**
 * Classifies a failed decision request: 401/403 are key problems, 402 is funds, a 400 that mentions
 * an unavailable model is a model problem, and everything else is transport. The message is
 * provider-agnostic and points at the option to check.
 */
export function describeProviderError(status: number, body: string): ProviderErrorInfo {
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 200) || "(empty body)";
  const kind: ProviderErrorKind =
    status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "funds"
        : status === 400 && /model is unavailable/i.test(body)
          ? "model"
          : "transport";

  const headline: Record<ProviderErrorKind, string> = {
    auth: `decision endpoint rejected the API key (HTTP ${status}); check apiKey, apiKeyEnv and apiKeyCommand`,
    funds: `decision endpoint reports insufficient funds (HTTP ${status}); top up the account or use another provider`,
    model: `decision endpoint does not serve the configured model (HTTP ${status}); check the model option`,
    transport: `decision endpoint request failed (HTTP ${status})`,
  };

  return {
    kind,
    status,
    message: `fast-opencode-compaction: ${headline[kind]} — endpoint said: ${detail}`,
  };
}

/** Identifies this plugin to the endpoint; override it through `headers["user-agent"]`. */
const DEFAULT_USER_AGENT = "fast-opencode-compaction/0.1";

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

/**
 * Builds the `ask(state, questions)` function for a resolved provider. The request shape comes from
 * `buildJevRequest` and the response is parsed by `parseJevResponse`, so the wire contract stays
 * owned upstream; this function only adds transport, headers, the timeout and error visibility.
 *
 * `config.headers` is where per-call extras go, for example `x-opencode-session`; the plugin's
 * User-Agent is added unless the caller overrode it. A missing API key is not fatal here — the key
 * is sent as configured and the endpoint's rejection is classified as an auth error. Every request
 * aborts after `config.timeoutMs`, and a non-2xx response is both warned about once and thrown as a
 * classified `ProviderRequestError`.
 */
export function createAsker(
  config: ResolvedProviderConfig,
  fetchImpl: typeof fetch = fetch,
): DecisionAsker {
  return {
    async ask(state, questions) {
      const apiKey = resolveApiKey(config) ?? "";
      const request = buildJevRequest(
        { apiKey, model: config.model, baseUrl: config.baseUrl },
        state,
        questions,
      );

      const headers: Record<string, string> = { ...request.headers, ...config.headers };
      if (!hasHeader(headers, "user-agent")) headers["user-agent"] = DEFAULT_USER_AGENT;

      const response = await fetchImpl(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const text = await response.text();

      if (!response.ok) {
        const info = describeProviderError(response.status, text);
        warnOnce(`${config.provider}:${info.kind}:${config.baseUrl}`, info.message);
        throw new ProviderRequestError(info);
      }

      return parseJevResponse(response.status, response.ok, text).answers;
    },
  };
}
