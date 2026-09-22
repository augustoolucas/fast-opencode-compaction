# fast-opencode-compaction

A native opencode V2 plugin that prunes stale tool calls and their results from the outgoing request,
using a typed-decision endpoint to decide, call by call, what the model still needs — user and
assistant text always stay verbatim. It is provider-agnostic: TypeSafe Jev, the OpenCode Zen free
tier, or any local endpoint that implements the same wire contract ([PROTOCOL.md](./PROTOCOL.md)) can
drive the decisions, and the compaction algorithm comes from
[`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction).

## What it does

- Hooks the V2 `context` event, which fires once per model call.
- Below `thresholdTokens` it does nothing at all — no decision request, no changes.
- Above it, it sends the conversation state (results omitted) plus two questions per candidate tool
  call — *should this call stay?* and *should its result stay verbatim?* — to your endpoint, and
  applies the answers to the request:
  - **drop_call** removes the tool call and its result;
  - **drop_result** keeps the first 300 characters and appends
    `[fast-opencode-compaction truncated N chars of this tool result; re-run the tool if needed]`.
- Remembers decisions per process and re-applies them on every request, and adds a note to
  compaction requests so a shortened result is not mistaken for a tool failure.

## What it does not do

- It never rewrites user or assistant text, reasoning or media parts — only tool calls and results.
- It changes the **outgoing request only**; nothing is written back to the session, so what you see in
  the transcript is untouched.
- It never summarises, never calls a model itself, and never blocks your request: any failure (no
  key, endpoint error, malformed answer) leaves the request exactly as it was and is reported once.
- It does not run on opencode 1.x — the V2 hook API (`ctx.session.hook`) does not exist there.

## Install

opencode loads plugins per project when a session starts. Three install forms are verified to work
(see [docs/spike-v2-hooks.md](./docs/spike-v2-hooks.md) for the evidence).

### 1. Package (recommended)

```sh
opencode plugin add fast-opencode-compaction
```

`opencode plugin add` installs the package through opencode's npm cache and adds it to the global
configuration. Configure options in the entry it writes:

```jsonc
{
  "plugins": [
    { "package": "fast-opencode-compaction", "options": { "provider": "zen" } }
  ]
}
```

> The package is not on npm yet (the project is prepared for publishing, not published). Until it is,
> use one of the local forms below.

### 2. Project-local file (auto-discovery)

opencode auto-discovers every `*.ts` file under `.opencode/plugins/`. A one-line re-export is enough:

```ts
// .opencode/plugins/fast-opencode-compaction.ts
export { default } from "fast-opencode-compaction/server";
```

This form gets **no plugin options** (there is no config entry to attach them to), so configure it
with environment variables — see [Providers](#providers).

### 3. Directory entry

A `plugins` entry may point at a **directory**, which must contain an `index.ts`:

```jsonc
{
  "plugins": ["./.opencode/compaction"]
}
```

```ts
// .opencode/compaction/index.ts
export { default } from "fast-opencode-compaction/server";
```

> A `plugins` entry pointing at a **file** is rejected by opencode with
> `configured plugin path must be a directory` — that is expected, and the file is ignored.

### After installing

Start a new session (or restart opencode if the plugin does not load). When no endpoint is configured
at all, the plugin stays off and says so once:

```
fast-opencode-compaction: no decision endpoint configured (set TYPESAFE_API_KEY or OPENCODE_API_KEY,
or pass a provider option); the plugin stays off
```

## Quick start

The fastest path is an environment variable plus the auto-detected provider.

### OpenCode Zen (free tier, limited time)

```sh
export OPENCODE_API_KEY=...   # from your OpenCode Zen account
```

That is it: the plugin detects `zen`, and uses `https://opencode.ai/zen/v1/systemone` with the model
`jev-1.13-free`. The paid `jev-1.13` model needs Zen credit; without it the endpoint answers
`HTTP 402 Insufficient account funds`.

### TypeSafe

```sh
export TYPESAFE_API_KEY=...
```

The plugin detects `typesafe` and uses `https://api.typesafe.ai/v1/systemone` with `jev-latest`.

`TYPESAFE_API_KEY` wins when both are set. To be explicit (or to override anything), add a config
entry — see [Providers](#providers).

## Configuration

Every option is optional. Options come from the plugin entry's `options` object in `opencode.jsonc`
(or `cli.json`), and the key can also come from the environment.

| Option | Default | Meaning |
| --- | --- | --- |
| `provider` | auto-detected | `typesafe`, `zen` or `custom`. Required for `custom`. |
| `baseUrl` | per provider | Endpoint; must speak [PROTOCOL.md](./PROTOCOL.md). |
| `model` | per provider | Decision model name sent in the request body. |
| `apiKey` | — | Inline key; wins over `apiKeyEnv` and `apiKeyCommand`. |
| `apiKeyEnv` | per provider | Environment variable to read the key from (empty for `custom`). |
| `apiKeyCommand` | — | argv whose stdout is the key, run without a shell (3 s timeout). |
| `headers` | `{}` | Extra request headers. The plugin adds `x-opencode-session` per call and `user-agent: fast-opencode-compaction/0.1` unless overridden here. |
| `timeoutMs` | `20000` | Request timeout; the decision call runs inside a pre-request hook, so a hung endpoint must not hold your model call. |
| `thresholdTokens` | per provider | Estimated request tokens below which the plugin does nothing. |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay; raise it to prune more. |
| `preserveRecent` | `6` | Newest messages never touched (the first message is always kept). |
| `maxStateTokens` | per provider | Token ceiling for the state sent to the endpoint. |
| `maxRequestTokens` | per provider | Token ceiling for state plus one batch of questions. |
| `enabled` | `true` | `false` keeps the plugin off without uninstalling it. |

### Provider defaults

| | `typesafe` | `zen` | `custom` |
| --- | --- | --- | --- |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | `https://opencode.ai/zen/v1/systemone` | *required* |
| `model` | `jev-latest` | `jev-1.13-free` | *required* |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | `OPENCODE_API_KEY` | — |
| `thresholdTokens` | `60000` | `60000` | `20000` |
| `maxStateTokens` | `25000` | `25000` | `900` |
| `maxRequestTokens` | `30000` | `30000` | `1200` |

Auto-detection order: `TYPESAFE_API_KEY`, then `OPENCODE_API_KEY`. A `baseUrl`/`model` without a
`provider` is not enough — name `custom` explicitly.

## Providers

### TypeSafe

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": { "provider": "typesafe" }
    }
  ]
}
```

Key from `TYPESAFE_API_KEY`, or pass `apiKey` / `apiKeyEnv` / `apiKeyCommand`.

### OpenCode Zen

```jsonc
{
  "plugins": [
    { "package": "fast-opencode-compaction", "options": { "provider": "zen" } }
  ]
}
```

The free tier model `jev-1.13-free` is free for a limited time; the paid `jev-1.13` answers
`402` until the account has Zen credit. System One only routes on the Zen base URL — the Go route
(`https://opencode.ai/zen/go/v1/systemone`) rejects the request even with a session id.

### Custom (any endpoint that speaks the protocol)

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": {
        "provider": "custom",
        "baseUrl": "http://127.0.0.1:8765/v1/systemone",
        "model": "my-local-decider",
        "maxStateTokens": 900,
        "maxRequestTokens": 1200,
        "thresholdTokens": 15000
      }
    }
  ]
}
```

`custom` has no defaults for `baseUrl` and `model`, and no key is required — a local bridge can
ignore the `Authorization` header. See [docs/provider-recipes.md](./docs/provider-recipes.md) for a
complete Laya bridge example, and [PROTOCOL.md](./PROTOCOL.md) for the contract it must implement.

## Tuning

- **`thresholdTokens`** decides when the plugin engages. Higher means fewer decision requests, less
  prompt-cache invalidation and less saving; lower means the plugin works on smaller requests. On
  large-context models the default 60000 keeps it out of the way until a request is genuinely big.
- **`custom` / local models** should lower it: with `maxStateTokens: 900` there is no point waiting
  for a 60k-token request. `10000`–`20000` is a sensible range for a 1k-context model.
- **`keepThreshold`** is the minimum keep probability for a call or result. `0.5` is the algorithm
  library's default; the reference port ships `0.35` (more conservative, keeps more). Raise it
  towards `0.7` to prune harder, lower it to `0.35` if `rerunAfterDrop` in the telemetry is high.
- **`preserveRecent`** should stay at `2` or more. `0` lets the plugin prune the newest messages,
  which makes the model re-run tools whose results were just dropped; negative values are clamped
  to `0` by the algorithm library.
- **`maxStateTokens` / `maxRequestTokens`** are the budgets the state is fitted into. Raise them for
  very long sessions (the endpoint must accept the request), lower them for small local models.
- Dropped result bodies always keep 300 characters; this is deliberately not configurable.

## Telemetry

Everything lands in the state directory — `~/.local/share/opencode/fast-opencode-compaction`, or
wherever `FAST_OPENCODE_COMPACTION_STATE_DIR` points.

| File | Contents |
| --- | --- |
| `ledger.jsonl` | One line per run that changed the request; rotated to `ledger.jsonl.1` at 5 MB. |
| `stats.json` | Cumulative counters, merged on every write so restarts do not lose history. |
| `debug.log` | Verbose trace, only with `FAST_OPENCODE_COMPACTION_DEBUG=1`. |

Ledger fields: `at, session, reason, stage, tokensBefore, tokensAfter, tokensSaved, calls, dropped,
truncated, requests, ms, rerunAfterDrop, rerunAfterTruncate`. Counts and lengths only — no message
text, no tool results, no keys.

How to read it:

```sh
tail -1 ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
jq -s '{dropped: map(.dropped) | add, reruns: map(.rerunAfterDrop) | add, saved: map(.tokensSaved) | add}' \
  ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
```

- `tokensSaved` is what the pruning bought you for that request; `stage` says which fitting stage the
  state needed (`full` means it fitted as-is).
- **`rerunAfterDrop / dropped` is the quality signal.** Every dropped call that later comes back with
  the same tool and input under a new id was a re-run: if that ratio is high, the plugin is pruning
  things the model needed — lower `keepThreshold` or raise `preserveRecent`.
- `debug.log` is for troubleshooting only; it is off by default.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Nothing happens | The request is below `thresholdTokens` (per provider, default 60000; 20000 for `custom`). Lower it to engage earlier. |
| Nothing happens, one warning about "no decision endpoint" | No key and no `provider` option: set `TYPESAFE_API_KEY` / `OPENCODE_API_KEY`, or pass `provider`. |
| `HTTP 402` in a warning | The endpoint reports insufficient funds — for Zen that means the paid `jev-1.13` model needs credit; stay on `jev-1.13-free`. |
| `HTTP 400` + `Model is unavailable` | Wrong model name for that endpoint — check the `model` option. |
| `HTTP 401`/`403` | The key is missing or wrong — check `apiKey`, `apiKeyEnv` and `apiKeyCommand`. |
| Requests stop mid-day | The daily cap (200 decision requests) is reached; it resets with the local calendar day. Remove `usage.json` from the state directory to reset it. |
| `configured plugin path must be a directory` | You pointed a `plugins` entry at a file — use a directory with an `index.ts`, or the package form. |
| The plugin does not seem to load | Plugins load per project at session start: start a new session, or restart opencode. |
| `compact()`/fit errors in `debug.log` | The state does not fit the budgets; raise `maxStateTokens`/`maxRequestTokens`. |
| Tools keep re-running | `rerunAfterDrop` is high: lower `keepThreshold` (e.g. `0.35`) and keep `preserveRecent` at `2`+. |

## Development

```sh
npm install
npm test              # vitest, no network
npm run typecheck     # tsc --noEmit, covers tests too
npm run build         # tsc -p tsconfig.build.json -> dist/
```

- `docs/spike-v2-hooks.md` — what the V2 hooks actually do on this opencode build (measured).
- `docs/provider-recipes.md` — TypeSafe, Zen and a local Laya bridge.
- `PROTOCOL.md` — the wire contract every provider implements.

## License

MIT — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the algorithm's attribution.
