# Compaction Protocol

The wire contract between `fast-opencode-compaction` and a typed-decision endpoint (the "System One"
protocol). Any endpoint that implements this contract can be configured as the provider; the plugin
itself contains no vendor-specific code. The request builder and the response parser live upstream in
[`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction), which owns this format.

## Request

```http
POST <baseUrl>
Authorization: Bearer <apiKey>
content-type: application/json
```

Body:

```json
{
  "model": "jev-latest",
  "state": {
    "context": "…",
    "goal": "…",
    "history": [
      { "i": 0, "role": "user", "text": "…" },
      { "i": 1, "role": "assistant", "text": "…", "tool_calls": [] }
    ]
  },
  "questions": {
    "call_t1": {
      "type": "noul",
      "instructions": "Tool call t1 (read) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next"
    },
    "result_t1": {
      "type": "noul",
      "instructions": "The full output of tool call t1 (read, 1200 chars) should stay in the history verbatim"
    }
  }
}
```

### `model`

The decision model to use. Each provider defines its own default (`jev-latest` for TypeSafe,
`jev-1.13-free` for the OpenCode Zen free tier, a local model for custom endpoints).

### `state`

The conversation to reason over, with tool results omitted: a string or any JSON-serialisable object.
The plugin sends the full history in the `CompactionState` shape shown above — `context` (surrounding
session context), `goal` (ongoing task) and `history` (one entry per message, `i` being the message
index, with `tool_calls` either structured per call or a compact line per call once the state has to
shrink). The state is fitted into a per-provider token budget before it is sent, so the endpoint
always receives a complete, self-consistent state.

### `questions`

An object keyed by question name. Each question has a `type` and `instructions` (a natural-language
description of what is being asked), plus a type-specific `criteria`:

| `type` | Answer field | `criteria` |
| --- | --- | --- |
| `noul` | `noul` — probability that the proposition holds | optional `{ "true"?: string, "false"?: string }` describing what each outcome means |
| `choice` | `choice` — one of the option keys | required `{ "<option>": "<description>" \| null, … }` |
| `score` | `score` — a number | required `["<criterion>", …]` |

The plugin asks two `noul` questions per candidate tool call, named `call_<id>` and `result_<id>`:
whether the call itself still matters, and whether its result still needs to stay verbatim. Names are
how answers are matched back to questions, so they must be unique within one request.

## Response

`200 OK`, `content-type: application/json`:

```json
{
  "model": "jev-latest",
  "answers": {
    "call_t1": { "type": "noul", "noul": 0.95 },
    "result_t1": { "type": "noul", "noul": 0.2 }
  },
  "usage": { "input_tokens": 1234, "output_tokens": 5 }
}
```

### `answers`

Required, and the only field that is validated. An object keyed by the same names as the request's
`questions`; every question asked must be answered:

- `noul` — `{ "type"?: "noul", "noul": number }`
- `choice` — `{ "type"?: "choice", "choice": string, "confidence": number, "probabilities": { "<option>": number } }`
- `score` — `{ "type"?: "score", "score": number, "confidence": number, "probabilities": { … } }`

A missing or malformed `answers` object, or an answer that is missing its type-specific field, is an
error and must not be treated as an answer.

### `usage` and other fields

Optional. `usage` carries `input_tokens` / `output_tokens` when the provider reports them. **Unknown
response fields must be ignored**: providers may add routing metadata, extra usage accounting or
anything else, so a response must be parsed by reading `answers` (and optionally `usage`) and
disregarding the rest.

## Providers

- **TypeSafe** — `https://api.typesafe.ai/v1/systemone`, model `jev-latest`. Implements this contract
  natively.
- **OpenCode Zen** — `https://opencode.ai/zen/v1/systemone`, model `jev-1.13-free`. Implements this
  contract natively.
- **Laya** — returns the same `answers` envelope, so it can be used behind a user-provided bridge that
  adapts it to this contract.
- **Custom** — any endpoint that speaks this contract; smaller token budgets apply.
