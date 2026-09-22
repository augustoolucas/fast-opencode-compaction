# Spike: V2 plugin hook semantics (task 02)

What the probe in [`spike/hook-probe/`](../spike/hook-probe/README.md) observed on the installed
opencode, before `src/` depends on any of it. Every claim below is backed by a log line from
`spike/hook-probe/.opencode/logs/probe.jsonl` (counts and lengths only — the probe never logs message
content). Raw captures of each run live next to it as `segment-*` files; all of that directory is
git-ignored, so the quotes here are the durable record.

## Environment (one deviation from the plan)

| | |
| --- | --- |
| opencode | **v2.0.14** — `opencode --version` → `opencode v2.0.14`; `/home/lucas/.opencode/bin/opencode`. The plan targeted 2.0.12; V1 binaries (1.18.31) only exist as backups (`/tmp/opencode/v1`, `~/backups/opencode-v1-migration-2026-09-20`). |
| `@opencode/plugin` | `2.0.12` in `node_modules` (devDependency, types only). The hook-relevant files are byte-identical to 2.0.14: `diff` of `dist/promise/{session,plugin,registration}.d.ts` between the two npm tarballs printed nothing. |
| V1 hook names | 0 occurrences of `experimental.chat.messages.transform` and `experimental.session.compacting` in the 2.0.14 binary (`strings`); `session.hook` occurs 9×. |
| V2 hook API | `ctx.session.hook(name, callback) => Promise<Registration>` (`registration.d.ts`), callbacks mutate the event in place. `Plugin.define` is the identity function (`plugin.js`: `export function define(plugin) { return plugin; }`). |
| server | a background service (`opencode serve --service`, pid 800813) started 2026-09-21 10:28 — a day *before* the probe existed — still loaded it for new sessions. Loading is per project and lazy; no restart needed. |

## Runs

The probe file's sha256 during runs A–C was `76d4504c…`, during C–H `85c86484…` (the `Plugin.define`
variant), and the committed file is `76d4504c…` again — i.e. the plain-object form that runs A/B and
I/J exercised.

| Run | Command (cwd `spike/hook-probe`) | Plugin location | `opencode.jsonc` `plugins` entry | Export | Capture |
| --- | --- | --- | --- | --- | --- |
| A | `opencode run "reply with ok"` | `.opencode/plugins/probe.ts` | file path | `{ id, setup }` | `segment-a.jsonl` |
| B | `opencode run -c "say ok again"` | same | file path | `{ id, setup }` | `segment-b.jsonl` |
| C | `opencode run --standalone --print-logs --log-level debug "define form check"` | same | file path | `Plugin.define` | `segment-c.jsonl`, `segment-c.log` |
| D | `opencode run --standalone "reply with ok"` | same | **none — file deleted** | `Plugin.define` | `segment-d.jsonl` |
| E/F | `opencode run --standalone --print-logs "reply with ok"` | `probe-explicit.ts` (outside `.opencode/plugins/`) | `./probe-explicit.ts` | `Plugin.define` | `segment-e/f.log` |
| G | `opencode run --standalone --print-logs "reply with ok"` | `.opencode/alt-plugins/probe.ts` (no index) | `./.opencode/alt-plugins` | `Plugin.define` | `segment-g.log` |
| H | `opencode run --standalone --print-logs "reply with ok"` | `.opencode/alt-plugins/index.ts` | `./.opencode/alt-plugins` | `Plugin.define` | `segment-h.log` |
| H2 | `opencode run --standalone "reply with ok"` | `.opencode/alt-plugins/index.ts` | `./.opencode/alt-plugins` | `Plugin.define` | `segment-h2.jsonl` |
| I | `opencode run "reply with ok" >/dev/null 2>&1` (the task's verification command) | restored | file path | `{ id, setup }` | `probe.jsonl` line 1 |
| J | `opencode run --standalone "reply with ok"` | same | file path | `{ id, setup }` | `probe.jsonl` lines 2–5 |

`probe.jsonl` was reset before run I, so its line numbers restart there; the earlier runs are quoted
from the `segment-*` captures. `segment-a…d.jsonl` are cumulative prefixes of that earlier log.

## (a) Does the plugin load and does `setup` run? — Yes

`segment-a.jsonl` (run A, background service pid 800813):

```json
{"at":"2026-09-22T14:50:27.837Z","pid":800813,"sessionID":null,"messages":null,"parts":null,"system":null,"tools":null,"firstTextLen":null,"hook":"setup.start","pluginID":"hook-probe","logFile":"/home/lucas/repos/fast-opencode-compaction/spike/hook-probe/.opencode/logs/probe.jsonl","sessionHookType":"function","contextKeys":["agent","aisdk","app","command","event","experimental","generate","integration","location","mcp","model","options","permission","plugin","provider","reference","rpc","session","shell","skill","storage","tool","vcs","websearch","worktree"],"options":{}}
{"at":"2026-09-22T14:50:27.837Z","pid":800813,"sessionID":null,"messages":null,"parts":null,"system":null,"tools":null,"firstTextLen":null,"hook":"setup","pluginID":"hook-probe","registered":2}
```

- `setup` receives the full documented `Context`: 25 keys, exactly the `plugin.d.ts` `Context`
  interface members; `session.hook` is a function; `options` is `{}`.
- Both registrations resolve: `registered: 2`.
- `setup` ran when the first session in that project was created — in a service process started a day
  earlier — and it ran **once per process**, not once per session or per call: run B (same process,
  different request) added only a `context` line, no second `setup`.

## (b) Does `context` fire once per model call, and what are `system`/`tools`? — Yes, once per call

`segment-a.jsonl` (run A) and `segment-b.jsonl` (run B, `-c`, same session):

```json
{"at":"2026-09-22T14:50:28.190Z","pid":800813,"sessionID":"ses_f36673a57ffedRbPw9SZyazgKv","messages":1,"parts":1,"system":{"present":true,"count":4,"chars":20681},"tools":{"present":true,"count":12},"firstTextLen":32,"hook":"context","contextCall":1,"markerPresent":false,"mutated":true,"lenBefore":15,"lenAfter":32}
{"at":"2026-09-22T14:50:57.811Z","pid":800813,"sessionID":"ses_f36673a57ffedRbPw9SZyazgKv","messages":4,"parts":5,"system":{"present":true,"count":4,"chars":20681},"tools":{"present":true,"count":12},"firstTextLen":15,"hook":"context","contextCall":2,"markerPresent":false,"mutated":false,"lenBefore":15,"lenAfter":15}
```

- Two model calls (one per `opencode run`) produced exactly two `context` calls, in the same process
  and the same session, and `contextCall` is the probe's own process-local counter — so one `context`
  per model call.
- `system` is a **present array**: `count: 4` parts, 20 681 chars total (a fifth run saw 22 897 chars
  — it is the assembled system prompt, not an empty field).
- `tools` is a **present object**: 12 entries, i.e. the tool schemas offered to the model.
- `messages`/`parts` are the outgoing request's messages (run A: 1 message / 1 part; run B: 4 / 5,
  the accumulated history including tool traffic later in a session).
- No `form`/`options`/`kind` field exists on the event; `SessionContext` has no request-kind, so a
  `context` call cannot tell a primary request from a title/generate request by itself.

## (c) Do mutations persist across calls/sessions? — No

Run A appended the marker to the first text part of the outgoing request (`mutated: true`,
`lenBefore: 15` → `lenAfter: 32`, +17 chars = the marker). The next call of the same session (run B,
`contextCall: 2`) shows the original length and no marker, and the session store does not contain it:

```json
{"at":"2026-09-22T14:50:57.811Z","pid":800813,"sessionID":"ses_f36673a57ffedRbPw9SZyazgKv","messages":4,"parts":5,"system":{"present":true,"count":4,"chars":20681},"tools":{"present":true,"count":12},"firstTextLen":15,"hook":"context","contextCall":2,"markerPresent":false,"mutated":false,"lenBefore":15,"lenAfter":15}
```

```
$ opencode session export ses_f36673a57ffedRbPw9SZyazgKv | grep -c "probe-marker"
0
```

- The event is mutated only for the request being built; it is **not written back** to the session or
  its store. A new session (run D) also starts clean.
- Implication for the plan's risk item: the apply step may mutate the event in place without polluting
  the session — but it cannot rely on its own earlier edits being present in the next call, and any
  state the plugin keeps between calls (caps, memo) must live in the plugin, not in the messages.

## (d) Is the V1-style hook ever invoked? — No

The probe's `setup` returns a callable cleanup that also carries `experimental.chat.messages.transform`
and `experimental.session.compacting` as own properties. Across all runs there is **no** `v1.*` line,
while the cleanup function itself *is* called:

```json
{"at":"2026-09-22T14:54:55.882Z","pid":897873,"sessionID":null,"messages":null,"parts":null,"system":null,"tools":null,"firstTextLen":null,"hook":"cleanup"}
```

- `setup`'s return value is treated as a **disposal function** (`Cleanup`), not as a hook map: it is
  called when a standalone server shuts down and when the plugin is hot-reloaded (see below).
- Combined with the binary test (0 occurrences of both V1 names), V1 hooks are dead on this build;
  the community port's `experimental.chat.messages.transform` cannot fire.

## (e) Which export and config forms does the loader accept?

Export form — **both** work:

- plain `export default { id, setup }`: runs A/B/I/J (sha `76d4504c…`).
- `export default Plugin.define({ id, setup })`: runs C/D/H2 (sha `85c86484…`), including a bare
  `import { Plugin } from "@opencode/plugin"` resolved from the repo's `node_modules`.

Config form — the explicit entry as a **file path is rejected**; what loads the local plugin is
`.opencode/plugins/*.ts` auto-discovery:

```
timestamp=2026-09-22T14:52:57.739Z level=WARN run=371764e8 message="configured plugin path must be a directory" target=/home/lucas/repos/fast-opencode-compaction/spike/hook-probe/probe-explicit.ts http.span=266 role=server
```

- Run D proves auto-discovery is the load-bearing mechanism: with `opencode.jsonc` deleted entirely,
  a fresh server still ran `setup` (`segment-d.jsonl`, pid 896810) and a `context` call, and the model
  answered "ok".
- A configured **directory** does load, and it takes the directory's `index.ts`:

```
timestamp=2026-09-22T14:53:50.729Z level=INFO run=1883f21c msg="loading plugin" id=/home/lucas/repos/fast-opencode-compaction/spike/hook-probe/.opencode/alt-plugins entrypoint=file:///home/lucas/repos/fast-opencode-compaction/spike/hook-probe/.opencode/alt-plugins/index.ts http.span=471 role=server
{"at":"2026-09-22T14:55:25.149Z","pid":898069,"sessionID":null,"messages":null,"parts":null,"system":null,"tools":null,"firstTextLen":null,"hook":"setup","pluginID":"hook-probe","registered":2}
{"at":"2026-09-22T14:55:26.092Z","pid":898069,"sessionID":"ses_f3662b338ffezOLdm3viPYBV9U","messages":3,"parts":3,"system":{"present":true,"count":4,"chars":20698},"tools":{"present":true,"count":12},"firstTextLen":52,"hook":"context","contextCall":1,"markerPresent":false,"mutated":true,"lenBefore":35,"lenAfter":52}
```

- A directory **without** an `index.*` loaded nothing and logged nothing (run G).
- Package-style entries load through the npm cache: `msg="loading plugin" id=@cortexkit/opencode-magic-context entrypoint=file:///home/lucas/.cache/opencode/npm/…`.
- The committed `spike/hook-probe/opencode.jsonc` keeps the spec's explicit file path, which the
  loader warns about and ignores; the probe itself loads by auto-discovery. It is kept as the
  documented negative result rather than deleted.

## Extra observations (not asked for, cheap to record)

- **Hot reload**: editing the probe file while the service ran produced `cleanup` → `setup.start` →
  `setup` in the same pid (`segment-c.jsonl`, 14:51:28.595–.597) — the watcher reloads plugins, and
  the returned cleanup is called before the new instance registers.
- **`--standalone`** gives a private server per run: fresh `setup`, its own pid, and a `cleanup` on
  exit. `opencode run` without it goes to the background service, which may already hold the plugin —
  that is why run I's log line is a bare `context`.
- **`compaction` never fired.** The hook registered fine, but the user's global config sets
  `compaction.auto: false` and no CLI path forces a compaction, so this spike has **no** observed
  `compaction` line. Treat the compaction hook as unverified until task 06/09 exercises it with
  auto-compaction enabled.
- Debug-level server logs (`--print-logs --log-level debug`) do **not** contain request bodies; the
  marker appended to the outgoing messages was not visible in them, so whether a mutation reaches the
  provider request could not be confirmed from logs alone (the model reply is the only observable
  effect).
