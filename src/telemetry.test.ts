/**
 * Telemetry tests: ledger, rotation, counters that survive a restart, rerun attribution,
 * and the guarantee that no message or tool-result content ever reaches a telemetry file.
 *
 * The last test drives the real plugin wiring against a local `node:http` endpoint and
 * then greps every telemetry file for a distinctive marker that travelled through the request.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentPart, Message as V2Message } from "@opencode/ai";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetry, type ProviderBucket, type RunRecord, type TelemetryCall } from "./telemetry.js";
import { setup } from "./plugin.js";

const LEDGER = "ledger.jsonl";
const ROTATED = "ledger.jsonl.1";
const STATS = "stats.json";
const DEBUG = "debug.log";

const servers: Server[] = [];
let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "fast-opencode-compaction-telemetry-"));
  delete process.env.FAST_OPENCODE_COMPACTION_DEBUG;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.FAST_OPENCODE_COMPACTION_DEBUG;
  delete process.env.FAST_OPENCODE_COMPACTION_STATE_DIR;
  rmSync(directory, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    reason: "step",
    stage: "",
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    calls: 0,
    dropped: 0,
    truncated: 0,
    requests: 0,
    failures: 0,
    ms: 0,
    rerunAfterDrop: 0,
    rerunAfterTruncate: 0,
    ...overrides,
  };
}

function ledgerLines(): Array<Record<string, unknown>> {
  const text = readFileSync(join(directory, LEDGER), "utf8").trim();
  return text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stats(): Record<string, number> {
  return JSON.parse(readFileSync(join(directory, STATS), "utf8")) as Record<string, number>;
}

const call = (id: string, toolUseId: string, input: Record<string, unknown> = { command: "ls" }): TelemetryCall => ({
  id,
  tool_use_id: toolUseId,
  tool: "bash",
  input,
});

describe("ledger and counters", () => {
  it("writes one ledger line per changed run and counts every run", () => {
    const stamp = Date.parse("2026-09-22T12:00:00.000Z");
    const telemetry = createTelemetry(directory, () => stamp);

    telemetry.record("ses_1", run({ stage: "full", tokensBefore: 100, tokensAfter: 40, tokensSaved: 60, calls: 3, dropped: 1, truncated: 1, requests: 2, ms: 7 }));
    telemetry.record("ses_1", run({ calls: 1 })); // changed nothing: no line

    expect(ledgerLines()).toEqual([
      {
        at: "2026-09-22T12:00:00.000Z",
        session: "ses_1",
        // No identity was passed to createTelemetry here, so the fallback is stamped.
        provider: "unknown",
        model: "unknown",
        reason: "step",
        stage: "full",
        tokensBefore: 100,
        tokensAfter: 40,
        tokensSaved: 60,
        calls: 3,
        dropped: 1,
        truncated: 1,
        requests: 2,
        ms: 7,
        rerunAfterDrop: 0,
        rerunAfterTruncate: 0,
      },
    ]);
    // The second run changed nothing, so it only reached the counters — and the first flush of the
    // minute already happened, so those deltas are still pending.
    expect(stats()).toMatchObject({
      runs: 1,
      changed: 1,
      calls: 3,
      dropped: 1,
      truncated: 1,
      requests: 2,
      tokensBefore: 100,
      tokensAfter: 40,
      tokensSaved: 60,
      ms: 7,
    });

    telemetry.flush();
    expect(stats()).toMatchObject({
      runs: 2,
      changed: 1,
      calls: 4,
      dropped: 1,
      truncated: 1,
      requests: 2,
      tokensBefore: 100,
      tokensAfter: 40,
      tokensSaved: 60,
      ms: 7,
    });
  });

  it("counts failures in stats.json and keeps them out of the ledger", () => {
    const telemetry = createTelemetry(directory);
    telemetry.record("ses_1", run({ dropped: 1, failures: 1 }));
    telemetry.flush();

    expect(stats()).toMatchObject({ runs: 1, changed: 1, dropped: 1, failures: 1 });

    const line = readFileSync(join(directory, LEDGER), "utf8").trim();
    expect(JSON.parse(line)).not.toHaveProperty("failures");
  });

  it("flushes at most once a minute and merges into the counters already on disk", () => {
    let stamp = Date.parse("2026-09-22T12:00:00.000Z");
    const telemetry = createTelemetry(directory, () => stamp);

    telemetry.record("ses_1", run({ dropped: 1 })); // first record flushes
    const afterFirst = readFileSync(join(directory, STATS), "utf8");

    stamp += 30_000;
    telemetry.record("ses_1", run({ dropped: 1 })); // still inside the minute: no flush
    expect(readFileSync(join(directory, STATS), "utf8")).toBe(afterFirst);

    stamp += 40_000;
    telemetry.record("ses_1", run({ dropped: 1 })); // past the minute: flush
    expect(stats()).toMatchObject({ runs: 3, changed: 3, dropped: 3 });

    // A restart (a new recorder on the same directory) adds to the file instead of replacing it.
    const afterRestart = createTelemetry(directory, () => stamp);
    afterRestart.record("ses_2", run({ truncated: 1 }));

    expect(stats()).toMatchObject({ runs: 4, changed: 4, dropped: 3, truncated: 1 });
  });

  it("rotates the ledger to a single generation once it passes 5 MB", () => {
    const oldLedger = "x".repeat(5 * 1024 * 1024 + 1);
    writeFileSync(join(directory, LEDGER), oldLedger);
    const telemetry = createTelemetry(directory, () => Date.parse("2026-09-22T12:00:00.000Z"));

    telemetry.record("ses_1", run({ dropped: 1 }));

    expect(existsSync(join(directory, ROTATED))).toBe(true);
    expect(readFileSync(join(directory, ROTATED), "utf8")).toBe(oldLedger);
    expect(ledgerLines()).toHaveLength(1);
    expect(ledgerLines()[0]).toMatchObject({ session: "ses_1", dropped: 1 });
  });

  it("never throws when the state directory cannot be used", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A file where the directory should be makes every write fail.
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    const telemetry = createTelemetry(blocked, () => Date.now());

    expect(() => telemetry.record("ses_1", run({ dropped: 1 }))).not.toThrow();
    expect(() => telemetry.flush()).not.toThrow();

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("telemetry failed");
  });
});

describe("rerun attribution", () => {
  it("counts a dropped call that comes back under a new id, once", () => {
    const telemetry = createTelemetry(directory, () => Date.now());

    telemetry.remember("ses_1", [call("t1", "call_A")], [{ action: "drop_call", id: "t1" }]);

    // The host re-sends the same request: same id, not a re-run.
    expect(telemetry.countReruns("ses_1", [call("t1", "call_A")])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });

    // The model re-ran the tool: same tool and input, new id.
    expect(telemetry.countReruns("ses_1", [call("t2", "call_B")])).toEqual({
      rerunAfterDrop: 1,
      rerunAfterTruncate: 0,
    });

    // The same re-run is not counted twice.
    expect(telemetry.countReruns("ses_1", [call("t2", "call_B")])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });

    // A different input is a different call, and other sessions have their own map.
    expect(telemetry.countReruns("ses_1", [call("t3", "call_C", { command: "pwd" })])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });
    expect(telemetry.countReruns("ses_2", [call("t4", "call_D")])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });
  });

  it("counts a truncated call coming back under a new id", () => {
    const telemetry = createTelemetry(directory, () => Date.now());
    telemetry.remember("ses_1", [call("t1", "call_A")], [{ action: "drop_result", id: "t1" }]);

    expect(telemetry.countReruns("ses_1", [call("t2", "call_B")])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 1,
    });
  });

  it("carries the tallies into the ledger line", () => {
    const telemetry = createTelemetry(directory, () => Date.parse("2026-09-22T12:00:00.000Z"));
    telemetry.remember("ses_1", [call("t1", "call_A")], [{ action: "drop_call", id: "t1" }]);
    const reruns = telemetry.countReruns("ses_1", [call("t2", "call_B")]);

    // Counted before this run's own decisions, so the very decision that pruned it is not blamed.
    telemetry.remember("ses_1", [call("t2", "call_B")], [{ action: "drop_call", id: "t2" }]);
    telemetry.record("ses_1", run({ dropped: 1, ...reruns }));

    expect(ledgerLines()[0]).toMatchObject({ dropped: 1, rerunAfterDrop: 1, rerunAfterTruncate: 0 });
    expect(stats()).toMatchObject({ runs: 1, changed: 1, dropped: 1, rerunAfterDrop: 1 });
  });

  it("bounds the per-session maps", () => {
    const telemetry = createTelemetry(directory, () => Date.now());

    for (let index = 0; index < 200; index += 1) {
      telemetry.remember(`ses_${index}`, [call("t1", "call_A")], [{ action: "drop_call", id: "t1" }]);
    }
    // The 201st session clears the maps, like the reference port.
    telemetry.remember("ses_200", [call("t1", "call_A")], [{ action: "drop_call", id: "t1" }]);

    expect(telemetry.countReruns("ses_0", [call("t2", "call_B")])).toEqual({
      rerunAfterDrop: 0,
      rerunAfterTruncate: 0,
    });
    expect(telemetry.countReruns("ses_200", [call("t2", "call_B")])).toEqual({
      rerunAfterDrop: 1,
      rerunAfterTruncate: 0,
    });
  });
});

describe("provider identity", () => {
  const clock = () => Date.parse("2026-09-22T12:00:00.000Z");

  it("stamps provider and model on every ledger line, right after session", () => {
    const telemetry = createTelemetry(directory, clock, { provider: "zen", model: "jev-1.13-free" });

    telemetry.record("ses_1", run({ dropped: 1, tokensSaved: 10, requests: 1 }));

    const [line] = ledgerLines();
    expect(line).toMatchObject({ session: "ses_1", provider: "zen", model: "jev-1.13-free" });
    expect(Object.keys(line ?? {}).slice(0, 4)).toEqual(["at", "session", "provider", "model"]);
  });

  it("accumulates byProvider buckets per identity, across instances", () => {
    const a = createTelemetry(directory, clock, { provider: "zen", model: "jev-1.13-free" });
    a.record("ses_a", run({ dropped: 1, requests: 1, tokensSaved: 100, rerunAfterDrop: 1 }));
    a.record("ses_a", run({ calls: 1 })); // unchanged run: counted in the bucket, no ledger line
    a.flush();

    const b = createTelemetry(directory, clock, { provider: "zen", model: "jev-1.13" });
    b.record("ses_b", run({ truncated: 1, requests: 1, tokensSaved: 50, rerunAfterTruncate: 1 }));

    const c = createTelemetry(directory, clock, { provider: "custom", model: "laya-typed-decisions" });
    c.record("ses_c", run({ dropped: 2, requests: 2, tokensSaved: 200 }));

    // A restart: a new recorder with the same identity adds to the same bucket.
    const d = createTelemetry(directory, clock, { provider: "zen", model: "jev-1.13-free" });
    d.record("ses_d", run({ dropped: 1, requests: 1, tokensSaved: 100, rerunAfterDrop: 1 }));

    const written = JSON.parse(readFileSync(join(directory, STATS), "utf8")) as {
      byProvider: Record<string, ProviderBucket>;
    };
    expect(written.byProvider).toEqual({
      "zen:jev-1.13-free": {
        runs: 3,
        changed: 2,
        dropped: 2,
        truncated: 0,
        requests: 2,
        tokensSaved: 200,
        rerunAfterDrop: 2,
        rerunAfterTruncate: 0,
      },
      "zen:jev-1.13": {
        runs: 1,
        changed: 1,
        dropped: 0,
        truncated: 1,
        requests: 1,
        tokensSaved: 50,
        rerunAfterDrop: 0,
        rerunAfterTruncate: 1,
      },
      "custom:laya-typed-decisions": {
        runs: 1,
        changed: 1,
        dropped: 2,
        truncated: 0,
        requests: 2,
        tokensSaved: 200,
        rerunAfterDrop: 0,
        rerunAfterTruncate: 0,
      },
    });

    // The global counters keep their shape and add up the same runs.
    expect(stats()).toMatchObject({
      runs: 5,
      changed: 4,
      dropped: 4,
      truncated: 1,
      requests: 5,
      tokensSaved: 450,
    });

    // Every changed run got a line, each tagged with its own identity.
    expect(ledgerLines().map((line) => `${line.provider}:${line.model}`)).toEqual([
      "zen:jev-1.13-free",
      "zen:jev-1.13",
      "custom:laya-typed-decisions",
      "zen:jev-1.13-free",
    ]);
  });
});

describe("content guarantee", () => {
  const marker = "MARKER-9f3a1b7c-DO-NOT-LOG";

  async function startEndpoint() {
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += String(chunk)));
      request.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model?: string; questions?: Record<string, unknown> };
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((name) => [
            name,
            { type: "noul", noul: name.startsWith("call_") ? 0.1 : 0.1 },
          ]),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: body.model, answers }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return `http://127.0.0.1:${port}/v1/systemone`;
  }

  const text = (value: string): ContentPart => ({ type: "text", text: value });
  const toolCall = (id: string, name: string, input: unknown): ContentPart =>
    ({ type: "tool-call", id, name, input }) as ContentPart;
  const toolResult = (id: string, name: string, value: string): ContentPart =>
    ({ type: "tool-result", id, name, result: { type: "text", value } }) as ContentPart;

  function v2(role: V2Message["role"], content: ContentPart[]): V2Message {
    return { role, content } as unknown as V2Message;
  }

  it("keeps message text, tool input and tool output out of every telemetry file", async () => {
    const baseUrl = await startEndpoint();
    process.env.FAST_OPENCODE_COMPACTION_DEBUG = "1";
    process.env.FAST_OPENCODE_COMPACTION_STATE_DIR = directory;

    const hooks: Record<string, (event: unknown) => unknown> = {};
    const ctx = {
      options: {
        provider: "custom",
        baseUrl,
        model: "test-model",
        apiKey: "test-key",
        thresholdTokens: 1,
        preserveRecent: 0,
      },
      session: {
        hook: async (name: string, callback: (event: unknown) => unknown) => {
          hooks[name] = callback;
          return { dispose: async () => {} };
        },
      },
    } as unknown as Parameters<typeof setup>[0];
    await setup(ctx);

    const event = {
      sessionID: "ses_content",
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      system: [{ type: "text", text: `system prompt ${marker}` }],
      messages: [
        v2("user", [text(`please run ${marker}`)]),
        v2("assistant", [toolCall("call_1", "bash", { command: `echo ${marker}` })]),
        v2("tool", [toolResult("call_1", "bash", `${marker} ${"z".repeat(400)}`)]),
      ],
      options: {},
      tools: { bash: { description: `runs ${marker}` } },
    } as unknown as SessionContext;

    await hooks.context(event);

    // The run did prune (a ledger line exists), so the absence below is meaningful.
    expect(ledgerLines().length).toBeGreaterThan(0);
    expect(ledgerLines()[0]).toMatchObject({ session: "ses_content", reason: "step" });

    for (const file of [LEDGER, ROTATED, STATS, DEBUG]) {
      const path = join(directory, file);
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf8");
      expect(content, `${file} must not contain message content`).not.toContain(marker);
    }
    // The trace file was actually used, so the guarantee covers it too.
    expect(readFileSync(join(directory, DEBUG), "utf8").length).toBeGreaterThan(0);
  });
});
