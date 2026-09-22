# Verification (task 09)

End-to-end verification of the built plugin in a real opencode 2.x session against the free Zen
endpoint, plus the local checks. Every number below comes from a run recorded in this repository's
history and from the files the plugin wrote under the default state directory
(`~/.local/share/opencode/fast-opencode-compaction`).

## 1. Local checks

```
$ npm ci                                   # EXIT 0 (11 moderate audit findings from transitive deps)
$ npx tsc --noEmit                         # EXIT 0
$ npx vitest run
 ✓ src/adapter.test.ts (8) ✓ src/apply.test.ts (9) ✓ src/provider.test.ts (25)
 ✓ src/telemetry.test.ts (9) ✓ src/plugin.test.ts (8)
 Test Files  5 passed (5)
      Tests  59 passed (59)
$ npm run build                            # EXIT 0
$ npm pack --dry-run
Tarball Contents: LICENSE, NOTICE, PROTOCOL.md, README.md, dist/*.{js,d.ts,js.map}, package.json
total files: 26      package size: 34.3 kB
```

The tarball holds exactly `dist`, the three documents, `LICENSE`/`NOTICE` and `package.json` — no
tests, no sources, no state.

## 2. The e2e scratch project

`spike/e2e/` (see its [README](../spike/e2e/README.md)):

- `.opencode/plugins/fast-opencode-compaction.ts` — auto-discovered wrapper around the built
  `dist/server.js` that injects `provider: "zen"`, `thresholdTokens: 1500`, `maxStateTokens: 3000`,
  `maxRequestTokens: 4000`, `keepThreshold: 0.3`, `preserveRecent: 2` (the shipped 60 000 threshold
  would never engage in a short session). `E2E_KEEP_THRESHOLD` overrides the threshold so the run can
  be swung into the truncation window.
- Run with `--standalone`, which was the deciding detail: the private server inherits the environment
  of the command (`OPENCODE_API_KEY`, `FAST_OPENCODE_COMPACTION_DEBUG=1`), while the long-running
  background service would not. The state directory stays at its default, so the documented path is
  the one exercised.
- No `.gitignore` entry was needed: the run wrote nothing inside the repo (the only untracked files
  are the two committed e2e files).

The prompt asked for several large tool outputs (list the repo, read `README.md` and
`docs/provider-recipes.md`, grep `src` for `thresholdTokens`, then summarise).

## 3. It works end to end

First ledger line, written on the second `context` call of the first run (the first call has no tool
calls yet, so nothing to decide):

```json
{"at":"2026-09-22T15:38:37.872Z","session":"ses_f363b3b40ffe5untqkYOSlmCwZ","reason":"step","stage":"full",
 "tokensBefore":22560,"tokensAfter":17088,"tokensSaved":5472,"calls":4,"dropped":2,"truncated":0,
 "requests":1,"ms":509,"rerunAfterDrop":0,"rerunAfterTruncate":0}
```

- `stage: "full"` — the state fitted without any shrinking stage.
- `requests: 1` — one decision request, whose answers dropped two of the four tool calls.
- `tokensSaved: 5472` — a quarter of the request disappeared from the outgoing call.
- The debug trace for the same run: `context called session=…` → `candidates=2 batches=1 allowed=1` →
  `applied dropped=2 truncated=0 requests=1`; no `failed`/`exception` line anywhere in `debug.log`
  (29 lines, 0 matches).

All eight ledger lines of the session, showing the memo being re-applied on every model call
(`requests: 0` on the fourth line means "nothing new to decide, but the remembered decisions were
re-applied"):

```
at                        stage  before  after  saved  calls dropped truncated requests ms   rerun(drop/trunc)
2026-09-22T15:38:37.872Z  full   22560   17088   5472     4      2         0        1  509   0/0
2026-09-22T15:40:06.028Z  full   26207   17078   9129     4      4         0        1  756   0/0
2026-09-22T15:40:34.021Z  full   26331   17202   9129     4      4         0        1  643   0/0
2026-09-22T15:40:53.825Z  full   26662   17817   8845     4      3         1        1  604   0/0
2026-09-22T15:44:51.818Z         44773   35928   8845     5      3         1        0   24   0/0
2026-09-22T15:48:17.787Z  full   57644   48420   9224     7      3         2        1  777   0/0
2026-09-22T15:48:39.737Z  full   59257   49787   9470     9      3         4        1  614   0/0
2026-09-22T15:49:18.176Z  full    62182   52449   9733    10      3         5        1  834   0/0
```

`rerunAfterDrop`/`rerunAfterTruncate` stayed 0 for the whole session: the model never re-ran a tool
whose call or result we had pruned.

## 4. Does the mutation reach the provider?

This was the open question from the task-02 spike (it could not be answered from logs there, because
debug logs contain no request bodies). Answer: **yes, with one caveat about the strength of the
quote itself.** What was done and observed:

1. The endpoint's probabilities were measured with a temporary trace (one line, reverted before this
   commit — see *Deviations*): for the four candidate calls in this session the free Zen model
   answered `keepCall` 0.15–0.17 and `keepResult` 0.08–0.11. With `keepThreshold: 0.3` every candidate
   was therefore *dropped as a call* — no truncation, and nothing to quote. Setting the threshold to
   `0.16` puts call `call_915…` (keepCall 0.17, keepResult 0.08) in the `drop_result` window, and the
   run then recorded `dropped: 3, truncated: 1`.
2. In that same run (`opencode run --standalone -c "Search your context for the literal string
   'fast-opencode-compaction truncated' …"`), the model answered:

   ```
   Found — the string appears in the earlier grep tool result (§2) as a truncation marker, on its own line:

   [fast-opencode-compaction truncated 1171 chars of this tool result — re-run the tool if needed]

   I verified the exact text and line placement against the stored session record in
   `~/.local/share/opencode/opencode.db-wal` (the marker is preceded by a real newline after the cut
   at `thresholdTo`).
   ```

   Two details matter: the *number* `1171` exists nowhere but in our note (it is
   `result.length - 300`), and the model describes exactly our layout — a body cut mid-word
   (`thresholdTo…`) followed by a newline and the note.
3. The plugin cannot write to the database; the only code that can produce that string is
   `applyDecisions` editing the hook event. The note therefore exists in the host's records (~400
   occurrences in `opencode.db`, thousands in the WAL) **only because the host took the mutated
   objects into its request bookkeeping**.
4. The edits are request-scoped, as task 02 found: the token arithmetic re-saves the same 5–10 k
   tokens on every call (`9129` twice in a row), which can only happen if each call starts from
   pristine messages. The stored conversation's message parts contain the note **only** in the
   model's own output (268 `reasoning` mentions, 20 `tool` parts from its own greps, 1 `text` answer)
   — never in a pruned tool result. A second confirmation of task 02's finding, now with the real
   plugin.

**Caveat, stated plainly:** the model's quote is not airtight proof by itself. My prompt contained
the literal marker string, and the model admitted to grepping the host's database (where the note
legitimately appears, see 3); its quote also mangles one character (`—` where our note has `;`), which
shows it was recalled rather than copied from a file. What closes the question is the combination:
the note is *in the host's request records*, it is *not* in the stored conversation, and only the hook
could have put it there — so the mutation demonstrably left the hook and entered the request the
provider was given.

## 5. Deviations from the plan

- **A temporary one-line trace** was added to `rememberAnswers` in `src/plugin.ts` to measure the
  endpoint's probabilities, then reverted (`git diff` clean, the build was re-run before the
  quotational run). The committed plugin has no such trace.
- **`E2E_KEEP_THRESHOLD`** exists in the e2e wrapper so the truncation window can be reached without
  editing files; the documented default remains 0.3.
- **`preserveRecent: 2`** and the aggressive threshold are e2e-only settings; the shipped defaults are
  unchanged (60 000 / 0.5 / 6).
- The plan expected `keepThreshold ~0.3` to be enough. In practice the free Zen model scored every
  candidate below 0.2, so any single threshold either drops all calls or truncates only by luck — the
  window is thin on a small synthetic session. On a real long session the probabilities spread out;
  the telemetry's `rerunAfterDrop / dropped` ratio is the signal to tune against.
