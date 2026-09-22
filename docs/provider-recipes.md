# Provider recipes

`fast-opencode-compaction` talks to one endpoint that implements the wire contract in
[PROTOCOL.md](../PROTOCOL.md): `POST <baseUrl>` with `{model, state, questions}` and `200
{answers: …}`. These recipes are copy-paste configurations for the three supported shapes.

Every option below is documented in the [README](../README.md#configuration); the key can always come
from an environment variable instead of a config value.

## TypeSafe

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": {
        "provider": "typesafe",
        "baseUrl": "https://api.typesafe.ai/v1/systemone",
        "model": "jev-latest"
      }
    }
  ]
}
```

The key is read from `TYPESAFE_API_KEY` by default. Prefer not to keep it in the environment? Use a
command instead — it runs without a shell, with a 3-second timeout:

```jsonc
{
  "options": {
    "provider": "typesafe",
    "model": "jev-latest",
    "apiKeyCommand": ["pass", "show", "typesafe/jev"]
  }
}
```

Resolution order is `apiKey` → `apiKeyEnv` → `apiKeyCommand`, and a resolved key is cached for the
life of the opencode process. This provider keeps the big-context defaults (`thresholdTokens: 60000`,
`maxStateTokens: 25000`, `maxRequestTokens: 30000`).

## OpenCode Zen

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": { "provider": "zen" }
    }
  ]
}
```

- `OPENCODE_API_KEY` is read by default; the endpoint is
  `https://opencode.ai/zen/v1/systemone`.
- `jev-1.13-free` is free for a limited time — start there.
- The paid `jev-1.13` model answers `402 {"error":{"type":"server_error","message":"Insufficient
  account funds"}}` until the Zen account has credit; the plugin reports that once and leaves your
  request untouched.
- `jev-latest` is a TypeSafe model name, not a Zen one: on Zen it answers
  `400 … "Model is unavailable."`.
- System One only routes on the Zen base URL. The Go route
  (`https://opencode.ai/zen/go/v1/systemone`) rejects the request (`400 MissingSessionID`) even when
  the plugin sends `x-opencode-session`.

## Aggregator routes

Two aggregators speak the System One protocol at the same model. The endpoint constants come from
[Jevvy](https://github.com/PanAchy/jevvy) (MIT, `packages/core/src/{openrouter,vercel}.ts`); both use
the same `Authorization: Bearer` header as TypeSafe and the same budgets/threshold
(`60000` / `25000` / `30000`).

> **Neither route is exercised live by us** — we have no OpenRouter or Vercel AI Gateway key, so these
> snippets are configuration recipes, not tested paths. `custom` stays the catch-all for any other
> System One endpoint.

### OpenRouter

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": {
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1/systemone",
        "model": "typesafe/jev-1.13"
      }
    }
  ]
}
```

The key is read from `OPENROUTER_API_KEY` by default. The provider has to be named explicitly: the
auto-detection order stays TypeSafe → Zen, so `OPENROUTER_API_KEY` alone leaves the plugin off (with
the usual one-line warning).

### Vercel AI Gateway

```jsonc
{
  "plugins": [
    {
      "package": "fast-opencode-compaction",
      "options": {
        "provider": "vercel",
        "baseUrl": "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
        "model": "typesafe-ai/jev"
      }
    }
  ]
}
```

The key is read from `AI_GATEWAY_API_KEY` by default, and `provider: "vercel"` is required for the
same reason as above.

### Anything else

For any other endpoint that implements [PROTOCOL.md](../PROTOCOL.md) — a self-hosted System One, an
internal gateway, another aggregator — use `provider: "custom"` with an explicit `baseUrl` and
`model`, and set the budgets to match the model's context. The recipe below is the worked example.

## Custom: a local Laya bridge

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

## Checking a provider end to end

1. Set `FAST_OPENCODE_COMPACTION_DEBUG=1` and start a session; `<state dir>/debug.log` shows hook
   calls, the gate, batches and any error.
2. Send a request big enough to pass `thresholdTokens`, then look at
   `<state dir>/ledger.jsonl` — one line per changed request, with `tokensSaved` and `stage`.
3. Watch `rerunAfterDrop / dropped`: a high ratio means the endpoint's decisions are too aggressive,
   so lower `keepThreshold` (0.35 is a good next step).
