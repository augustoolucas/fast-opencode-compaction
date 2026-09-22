# E2E scratch project (task 09)

Loaded by `opencode run --standalone` from this directory. It exists to prove the built plugin works
inside a real session:

- `.opencode/plugins/fast-opencode-compaction.ts` — auto-discovered wrapper around `dist/server.js`
  that injects e2e options (`zen` provider, `thresholdTokens: 1500`, budgets 3000/4000,
  `keepThreshold: 0.3`, `preserveRecent: 2`). The `zen` provider reads `OPENCODE_API_KEY`; the state
  directory stays at its default (`~/.local/share/opencode/fast-opencode-compaction`) so the
  documented path is the one exercised.
- `--standalone` matters: a private server inherits the environment of the command
  (`OPENCODE_API_KEY`, `FAST_OPENCODE_COMPACTION_DEBUG=1`), while the shared background service would
  not.

Run it (never echo the key) — build the repo first, the wrapper imports `dist/server.js`:

```sh
cd ../.. && npm run build && cd spike/e2e
OPENCODE_API_KEY=$(python3 -c "import json,pathlib;print(json.loads(pathlib.Path.home().joinpath('.local/share/opencode/auth.json').read_text())['opencode-go']['key'])") \
FAST_OPENCODE_COMPACTION_DEBUG=1 \
opencode run --standalone "list the files in ../../, read ../../README.md and ../../docs/provider-recipes.md, grep for thresholdTokens in ../../src, then summarise"
tail -1 ~/.local/share/opencode/fast-opencode-compaction/ledger.jsonl
```

Results are written up in [`../../../docs/verification.md`](../../../docs/verification.md).
