# fast-opencode-compaction

A native opencode V2 plugin that prunes stale tool calls and their results from the outgoing request,
using a typed-decision endpoint to decide, call by call, what the model still needs — user and
assistant text always stay verbatim. It is provider-agnostic: TypeSafe Jev, the OpenCode Zen free
tier, or any local endpoint that implements the same wire contract ([PROTOCOL.md](./PROTOCOL.md)) can
drive the decisions, and the compaction algorithm itself comes from
[`fast-jev-compaction`](https://www.npmjs.com/package/fast-jev-compaction).

**Status: not implemented yet.** This repository currently holds the package skeleton, the protocol
contract and the licensing only.
