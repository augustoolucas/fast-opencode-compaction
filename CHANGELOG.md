# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-09-22

### Added

- opencode V2 adapter for [`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction):
  the library decides, `ctx.session.hook("context")` prunes tool calls and results on the outgoing
  request, and the session is never modified.
- Installation straight from the git repository — `opencode plugin add
  fast-opencode-compaction@git+https://github.com/augustoolucas/fast-opencode-compaction.git` — with
  the package's entry points resolving to the TypeScript sources, so there is no build step on
  install.
- Provider presets `typesafe`, `zen`, `openrouter`, `vercel` and `custom`, with per-provider budgets,
  an engage threshold, a keep threshold and key resolution from `apiKey` / `apiKeyEnv` /
  `apiKeyCommand`.
- Telemetry: an append-only `ledger.jsonl` (one line per changed request) plus cumulative counters in
  `stats.json` with per-provider buckets, re-run attribution and a failure count.
- Documentation: `README.md`, `PROTOCOL.md` (wire contract), `docs/configuration.md` (options, tuning,
  troubleshooting) and `NOTICE` (upstream attribution).
