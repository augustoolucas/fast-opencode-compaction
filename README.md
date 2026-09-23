# fast-opencode-compaction

An **OpenCode V2 adapter for [`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction)**.

The algorithm is the library's: token estimation, state fitting, batching, the two typed questions per
tool call, and the keep/drop/truncate decisions. This repo is the OpenCode integration - it maps
OpenCode V2 messages to the library's message model, hooks `ctx.session.hook("context")`, applies the
decisions to the outgoing request, and configures the decision endpoint.

## What this adapter adds

| | `fast-jev-compaction` | `fast-opencode-compaction` |
| --- | --- | --- |
| Hook | `session.compact`, returning replacement messages | `ctx.session.hook("context")`, once per model call |
| Effect | replaces the compaction result | prunes the outgoing request; the session is never modified |
| Message model | assistant `tool_use` / user `tool_result` blocks | V2 parts: `tool-call` and `tool-result` paired by `id` (`src/adapter.ts`) |
| Providers | TypeSafe only (`TYPESAFE_API_KEY` or macOS keychain) | `typesafe`, `zen`, `openrouter`, `vercel`, `custom`; key from `apiKey` / `apiKeyEnv` / `apiKeyCommand` |
| Budgets | `maxStateTokens` | per provider, plus `thresholdTokens` (when to engage) and `keepThreshold` |
| Telemetry | none | `ledger.jsonl` + `stats.json` with `byProvider` buckets and re-run attribution |
| OpenCode 1.x | n/a | not supported - the V2 hook API does not exist there |

The wire contract it speaks is [PROTOCOL.md](./PROTOCOL.md); the decision behaviour is the library's,
so its documentation applies.

## Install

```sh
opencode plugin add fast-opencode-compaction@git+https://github.com/augustoolucas/fast-opencode-compaction.git
```

Or add to your `opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "fast-opencode-compaction@git+https://github.com/augustoolucas/fast-opencode-compaction.git",
      "options": { "provider": "zen" } }
  ]
}
```

## Configure

`provider` is `typesafe`, `zen`, `openrouter`, `vercel` or `custom`. Without it, the plugin
auto-detects `TYPESAFE_API_KEY` then `OPENCODE_API_KEY`, and stays off with a single warning when
neither is set.

| provider | endpoint | model | key |
| --- | --- | --- | --- |
| `typesafe` | `api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `zen` | `opencode.ai/zen/v1/systemone` | `jev-1.13-free` | `OPENCODE_API_KEY` |
| `openrouter` | `openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |
| `vercel` | `ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `custom` | *required* | *required* | optional |

All options, budgets, tuning and troubleshooting: [docs/configuration.md](./docs/configuration.md).
Local-model recipe (a Laya bridge): [docs/configuration.md#custom-a-local-laya-bridge](./docs/configuration.md#custom-a-local-laya-bridge).

## Cost & latency

Every request above `thresholdTokens` that has tool calls the plugin has not decided on yet pays one
serial round-trip to the decision endpoint inside the hook - bounded by `timeoutMs` (default 20 s) -
and prompt caching breaks from the first drop. That trade-off is what the ledger measures:
`tokensSaved` versus `rerunAfter*`.

## Telemetry

One JSONL line per run that changed the request:

```sh
tail -1 ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
```

Counts and lengths only - no message text, no tool results, no keys. `rerunAfterDrop / dropped` is the
quality signal: high means it is pruning things the model needed. `stats.json` groups the same
counters per `"<provider>:<model>"` in `byProvider`.

## Development

```sh
npm install && npm test        # vitest, no network
npm run typecheck
```

## License

MIT - see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the algorithm's attribution.
