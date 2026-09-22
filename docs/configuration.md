# Configuration reference

Every option, per-provider budget, tuning knob and troubleshooting entry for the adapter. The wire
contract is [PROTOCOL.md](../PROTOCOL.md); the local-model recipe (a Laya bridge) is under
[Custom: a local Laya bridge](#custom-a-local-laya-bridge) below.

## Install

opencode loads plugins per project when a session starts. The package is installed **straight from the
GitHub repository** — it is not on npm and will not be. There is no build step: the loader reads the
TypeScript sources directly.

### 1. Git install (primary)

```sh
opencode plugin add fast-opencode-compaction@git+https://github.com/augustoolucas/fast-opencode-compaction.git
```

`opencode plugin add` installs through opencode's plugin cache and writes the global configuration. The
equivalent config entry:

```jsonc
{
  "plugins": [
    { "package": "fast-opencode-compaction@git+https://github.com/augustoolucas/fast-opencode-compaction.git",
      "options": { "provider": "zen" } }
  ]
}
```

Pin a tag or a commit for stability — `…#v0.1.0` or `…#<sha>` — and update with
`opencode plugin update`.

### 2. Project-local file (auto-discovery, for development)

opencode auto-discovers every `*.ts` file under `.opencode/plugins/`. A one-line re-export is enough:

```ts
// .opencode/plugins/fast-opencode-compaction.ts
export { default } from "fast-opencode-compaction/server";
```

This form gets **no plugin options** (there is no config entry to attach them to), so configure it with
environment variables — see [Quick start](#quick-start) below.

### 3. Directory entry (for development)

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

### Loading rules measured on opencode 2.x

- A `plugins` entry pointing at a **file** is rejected with
  `configured plugin path must be a directory` — the entry is ignored, so point at a directory.
- Auto-discovery scans `.opencode/plugins/*.ts`; a single file path is not enough there either.
- Options arrive only through `plugins: [{ package, options }]` or the singular-key tuple form
  `"plugin": [["<dir>", { "options": { … } }]]`. The two keys accept different entry shapes, and
  declaring the same directory in both loads it once — the plural entry's options win.

### After installing

Start a new session, or restart opencode if the plugin does not load. When no endpoint is configured at
all, the plugin stays off and says so once (an explicit `enabled: false` stays silent instead):

```
fast-opencode-compaction: no decision endpoint configured (set TYPESAFE_API_KEY or OPENCODE_API_KEY,
or pass a provider option); the plugin stays off
```

## Options

Every option is optional. Options come from the plugin entry's `options` object in `opencode.jsonc`
(or `cli.json`), and the key can also come from the environment.

| Option | Default | Meaning |
| --- | --- | --- |
| `provider` | auto-detected | `typesafe`, `zen`, `openrouter`, `vercel` or `custom`. Required for `custom`, `openrouter` and `vercel`. |
| `baseUrl` | per provider | Endpoint; must speak [PROTOCOL.md](../PROTOCOL.md). |
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

Key resolution order is `apiKey` → `apiKeyEnv` → `apiKeyCommand`, and a resolved key is cached for the
life of the opencode process. `apiKeyCommand` is the way to keep a key out of the environment, e.g.
`"apiKeyCommand": ["pass", "show", "typesafe/jev"]`.

## Provider defaults

| | `typesafe` | `zen` | `custom` |
| --- | --- | --- | --- |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | `https://opencode.ai/zen/v1/systemone` | *required* |
| `model` | `jev-latest` | `jev-1.13-free` | *required* |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | `OPENCODE_API_KEY` | — |
| `thresholdTokens` | `60000` | `60000` | `20000` |
| `maxStateTokens` | `25000` | `25000` | `900` |
| `maxRequestTokens` | `30000` | `30000` | `1200` |

Auto-detection order: `TYPESAFE_API_KEY`, then `OPENCODE_API_KEY`. A `baseUrl`/`model` without a
`provider` is not enough — name `custom` explicitly, and the aggregator presets below have to be named
too (their keys are never auto-detected).

## Aggregator presets

Both speak System One with the same budgets and threshold as TypeSafe (`60000` / `25000` / `30000`) and
the same `Authorization: Bearer`. The endpoint constants come from [Jevvy](https://github.com/PanAchy/jevvy)
(MIT) — **we have no key for either route, so neither is exercised live by us.**

| Provider | `baseUrl` | `model` | `apiKeyEnv` |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |
| `vercel` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |

Anything else that speaks the protocol is `custom` — the worked example is
[Custom: a local Laya bridge](#custom-a-local-laya-bridge) below.

## Quick start

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
`402 {"error":{"type":"server_error","message":"Insufficient account funds"}}` until the account has
Zen credit. `jev-latest` is a TypeSafe model name, not a Zen one — on Zen it answers
`400 … "Model is unavailable."`. System One only routes on the Zen base URL — the Go route
(`https://opencode.ai/zen/go/v1/systemone`) rejects the request (`400 MissingSessionID`) even when the
plugin sends `x-opencode-session`.

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
ignore the `Authorization` header. See [Custom: a local Laya bridge](#custom-a-local-laya-bridge)
below for a complete bridge example, and [PROTOCOL.md](../PROTOCOL.md) for the contract it must
implement.

### Custom: a local Laya bridge

`custom` is for any endpoint you run yourself. It requires `baseUrl` and `model`, and does not need
an API key — the plugin sends `Authorization: Bearer ` (empty) when none is configured, which a local
bridge can ignore.

Laya does not speak the System One envelope directly, so put a small adapter in front of it. **The
bridge below is user-side: it ships with your setup, not with this plugin.**

```python
# laya_bridge.py — user-side adapter, exposes the contract in PROTOCOL.md on top of Laya.
#   pip install fastapi uvicorn    (+ your Laya installation, which provides the `laya` import)
#   uvicorn laya_bridge:app --host 127.0.0.1 --port 8765
import laya
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
router = laya.Router()


class Question(BaseModel):
    type: str                              # "noul" | "choice" | "score"
    instructions: str
    criteria: dict | list | None = None


class DecisionRequest(BaseModel):
    model: str | None = None               # the plugin's `model` option; the bridge may ignore it
    state: object                          # {"context": ..., "goal": ..., "history": [...]}
    questions: dict[str, Question]         # question name -> question


@app.post("/v1/systemone")
def systemone(request: DecisionRequest) -> dict:
    # One call per request, exactly as the protocol asks: state plus the questions.
    prediction = router.predict(request.state, request.questions)

    answers: dict[str, dict] = {}
    for name, question in request.questions.items():
        value = prediction[name] if isinstance(prediction, dict) else prediction
        if question.type == "noul":
            answers[name] = {"type": "noul", "noul": float(value)}
        elif question.type == "choice":
            answers[name] = {"type": "choice", "choice": str(value), "confidence": 1.0, "probabilities": {}}
        elif question.type == "score":
            answers[name] = {"type": "score", "score": float(value), "confidence": 1.0, "probabilities": {}}
        else:
            raise HTTPException(status_code=400, detail=f"unsupported question type: {question.type}")
    return {"answers": answers}
```

Smoke-test it before wiring it into opencode:

```sh
curl -s http://127.0.0.1:8765/v1/systemone \
  -H 'content-type: application/json' \
  -d '{"model":"laya-typed-decisions","state":{"context":"","goal":"","history":[]},
       "questions":{"call_t1":{"type":"noul","instructions":"Should tool call t1 stay?"}}}'
# -> {"answers":{"call_t1":{"type":"noul","noul":0.93}}}
```

Then point the plugin at it:

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": {
        "provider": "custom",
        "baseUrl": "http://127.0.0.1:8765/v1/systemone",
        "model": "laya-typed-decisions",
        "maxStateTokens": 900,
        "maxRequestTokens": 1200,
        "thresholdTokens": 15000,
        "preserveRecent": 4,
        "keepThreshold": 0.4,
        "timeoutMs": 30000
      }
    }
  ]
}
```

Notes for small local models:

- `maxStateTokens`/`maxRequestTokens` mirror Laya's small context (900/1200 above). If the state
  cannot be fitted, `fitState` throws, the plugin reports it once and your request goes through
  untouched — raise the budgets or lower `preserveRecent` in that case.
- `thresholdTokens: 15000` engages early enough to matter on a small context. The `custom` default
  (20000) is a compromise; lower it further if your sessions are short.
- `timeoutMs: 30000` gives CPU inference room; the decision call runs inside a pre-hook, so a slow
  endpoint still delays the model call — keep it as low as your hardware tolerates.
- `keepThreshold: 0.4` is slightly more conservative than the 0.5 default, which suits a small model
  that gives coarser probabilities.
- `preserveRecent: 4` keeps the newest turns out of the candidate set; never use `0` here, it makes
  the model re-run tools whose results were just dropped.

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

## Telemetry files

Everything lands in the state directory — `~/.local/share/opencode/fast-opencode-compaction`, or
wherever `FAST_OPENCODE_COMPACTION_STATE_DIR` points.

| File | Contents |
| --- | --- |
| `ledger.jsonl` | One line per run that changed the request; rotated to `ledger.jsonl.1` at 5 MB. |
| `stats.json` | Cumulative counters plus a `byProvider` map, merged on every write so restarts do not lose history. |
| `debug.log` | Verbose trace, only with `FAST_OPENCODE_COMPACTION_DEBUG=1`. |

Ledger fields: `at, session, provider, model, reason, stage, tokensBefore, tokensAfter, tokensSaved,
calls, dropped, truncated, requests, ms, rerunAfterDrop, rerunAfterTruncate`. Counts and lengths only
— no message text, no tool results, no keys.

How to read it:

```sh
tail -1 ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
jq -s '{dropped: map(.dropped) | add, reruns: map(.rerunAfterDrop) | add, saved: map(.tokensSaved) | add}' \
  ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
```

- `tokensSaved` is what the pruning bought you for that request; `stage` says which fitting stage the
  state needed (`full` means it fitted as-is).
- `provider` and `model` say which endpoint produced the line, and `stats.json` groups the same
  counters into `byProvider` buckets keyed `"<provider>:<model>"` — that is what makes routes
  comparable: the free Zen model (`zen:jev-1.13-free`), a paid route, or a local Laya bridge
  (`custom:laya-typed-decisions`) each get their own `dropped`/`truncated`/`rerunAfterDrop` numbers.
  The global counters stay alongside them, and both merge across restarts.
- **`rerunAfterDrop / dropped` is the quality signal.** Every dropped call that later comes back with
  the same tool and input under a new id was a re-run: if that ratio is high, the plugin is pruning
  things the model needed — lower `keepThreshold` or raise `preserveRecent`. Compare it per
  `byProvider` bucket to see which model decides better.
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
| `ignoring unknown option keys … — check for typos` | One or more option keys in your config are not real options and were ignored; the message names them (e.g. `thresholdToken` instead of `thresholdTokens`). The warning fires once per process. |

## Checking a provider end to end

1. Set `FAST_OPENCODE_COMPACTION_DEBUG=1` and start a session; `<state dir>/debug.log` shows hook
   calls, the gate, batches and any error.
2. Send a request big enough to pass `thresholdTokens`, then look at
   `<state dir>/ledger.jsonl` — one line per changed request, with `tokensSaved` and `stage`.
3. Watch `rerunAfterDrop / dropped`: a high ratio means the endpoint's decisions are too aggressive,
   so lower `keepThreshold` (0.35 is a good next step).
