# Hook probe (task 02 spike)

Throwaway evidence harness: it proves what the opencode V2 plugin API actually does on the installed
binary, before `src/` depends on any of it. Findings are written up in
[`../../docs/spike-v2-hooks.md`](../../docs/spike-v2-hooks.md).

## Layout

- `.opencode/plugins/probe.ts` — the probe. Registers `ctx.session.hook("context", …)` and
  `ctx.session.hook("compaction", …)`, and appends one JSON line per call to
  `.opencode/logs/probe.jsonl` with counts and lengths only (never message content). On the first
  `context` call it appends a marker to the first text part, then reports on later calls whether the
  marker is still there. `setup` also returns a V1-style hook object so that a loader which still
  reads the return value as a hook map has something to invoke.
- `opencode.jsonc` — declares the plugin explicitly, so loading does not depend on auto-discovery.
- `.opencode/logs/` — output directory, git-ignored.

## Run

```sh
cd spike/hook-probe
opencode run "reply with ok"
wc -l .opencode/logs/probe.jsonl
grep -c '"hook":"context"' .opencode/logs/probe.jsonl
```

Run it a second time in the same directory to compare a new session against the previous one. The
probe appends, so remove `.opencode/logs/probe.jsonl` (or copy it aside) between experiments to keep
segments apart.

## What to look for

| `hook` value in the log line | Means |
| --- | --- |
| `setup.start` | the module was loaded and `setup` was entered |
| `setup` | both `session.hook(…)` registrations resolved |
| `setup.error` | the hook API was missing or registration failed |
| `context` | one model call's outgoing request — `contextCall`, `markerPresent`, `mutated`, `lenBefore`, `lenAfter` are the persistence test |
| `compaction` | a compaction request — `resultSet` says whether a result was already set |
| `v1.experimental.chat.messages.transform` | the V1-style hook object was invoked, i.e. V1 hooks still run |
| `cleanup` | the value returned by `setup` was called |

## Observed loading form

Measured on the installed opencode (see `../../docs/spike-v2-hooks.md` for the log lines):

- What loads this probe is **auto-discovery**: every `*.ts` under `.opencode/plugins/`. With
  `opencode.jsonc` deleted entirely, a fresh server still ran `setup`.
- The explicit entry in `opencode.jsonc` is **ignored for files**: the loader only accepts directories
  or package names there and warns
  `message="configured plugin path must be a directory" target=…/probe.ts`. It is kept as the
  documented negative result.
- A configured **directory** does load, and it takes `<dir>/index.ts` (verified with
  `.opencode/alt-plugins/`); a directory without an `index.*` loads nothing.
- Export shape: both `export default { id, setup }` and `export default Plugin.define({ id, setup })`
  load (`Plugin.define` is an identity function, see `@opencode/plugin`'s `dist/promise/plugin.js`).

## Notes on running it

- `opencode run` uses the background service, which loads the plugin lazily for the project and keeps
  it: `setup` appears once per process, so a log from a warm service may contain only `context` lines.
  Use `opencode run --standalone` for a fresh process (fresh `setup`, and a `cleanup` on exit).
- Editing the probe file while the service runs triggers a hot reload: `cleanup` then `setup`.

