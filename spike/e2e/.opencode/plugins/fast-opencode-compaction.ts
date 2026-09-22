/**
 * E2E scratch plugin (task 09): loads the built repo entry and injects options that make a short
 * session actually engage the pruner — the shipped defaults (60000 tokens) are far above a run with
 * a handful of tool calls.
 *
 * `.opencode/plugins/*.ts` files are auto-discovered, so there is no config entry here; options are
 * injected in the wrapper because this form has no way to attach them.
 *
 * The relative import resolves from this file: spike/e2e/.opencode/plugins → ../../../../dist/.
 * A published install would import `fast-opencode-compaction/server` instead.
 *
 * Note: `spike/**` is outside the tsc program (see tsconfig.json `include`), so this file is not
 * type-checked; the cast below only keeps the shape honest for readers.
 */

import entry from "../../../../dist/server.js";

/** The slice of the host's Context this wrapper touches. */
interface Context {
  options?: Record<string, unknown>;
  session: {
    hook: (name: string, callback: (event: unknown) => unknown) => Promise<unknown>;
  };
}

/** Aggressive on purpose: a short session must cross the gate and have calls decided. */
const E2E_OPTIONS: Record<string, unknown> = {
  provider: "zen",
  thresholdTokens: 1_500,
  maxStateTokens: 3_000,
  maxRequestTokens: 4_000,
  // The e2e swings this one to land in the drop_result window (keepResult < t <= keepCall).
  keepThreshold: Number(process.env.E2E_KEEP_THRESHOLD ?? 0.3),
  preserveRecent: 2,
};

export default {
  id: "fast-opencode-compaction",
  setup: (ctx: Context) =>
    entry.setup({
      ...ctx,
      options: { ...E2E_OPTIONS, ...(ctx.options ?? {}) },
    } as unknown as Parameters<typeof entry.setup>[0]),
};
