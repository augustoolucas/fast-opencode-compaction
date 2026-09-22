/**
 * Provider layer (task 03).
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
export type ProviderName = "typesafe" | "zen" | "custom";

/** Endpoint, model and budget defaults for one provider. */
export interface ProviderDefaults {
  readonly baseUrl: string;
  readonly model: string;
  /** Environment variable consulted when `apiKey` is not set; empty means "no default". */
  readonly apiKeyEnv: string;
  readonly maxStateTokens: number;
  readonly maxRequestTokens: number;
}

/** Known endpoints. `custom` deliberately has no `baseUrl`/`model`: both must be provided. */
export const PROVIDER_DEFAULTS: Record<ProviderName, ProviderDefaults> = {
  typesafe: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY",
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  zen: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13-free",
    apiKeyEnv: "OPENCODE_API_KEY",
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
  },
  custom: {
    baseUrl: "",
    model: "",
    apiKeyEnv: "",
    maxStateTokens: 900,
    maxRequestTokens: 1_200,
  },
};

/** Defaults for the knobs `PROVIDER_DEFAULTS` does not pin. All overridable per plugin options. */
const OPTION_DEFAULTS = {
  /** A large state plus its questions can take a while to answer. */
  timeoutMs: 30_000,
  /** Below this the round trip costs more than the pruning can save. */
  thresholdTokens: 20_000,
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
 * Resolves the endpoint to use, or `undefined` when there is nothing to use: no explicit provider
 * and no known key in the environment, `enabled: false`, or a `custom` provider that is missing its
 * required `baseUrl`/`model` (that last case is also reported through `warnOnce`).
 */
export function resolveProviderConfig(
  options: ProviderConfig = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedProviderConfig | undefined {
  if (options.enabled === false) return undefined;

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
    thresholdTokens: options.thresholdTokens ?? OPTION_DEFAULTS.thresholdTokens,
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
