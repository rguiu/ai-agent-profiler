import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore } from "../store/index.js";
import { runParse } from "./run.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-parse-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

const ANTHROPIC_SSE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":10,"output_tokens":1}}}`,
  ``,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_weather"}}`,
  ``,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}`,
  ``,
].join("\n");

function writeTrace(dir: string): string {
  const events = [
    { type: "request", headers: {} },
    {
      type: "response",
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
    {
      type: "response_body",
      data: Buffer.from(ANTHROPIC_SSE).toString("base64"),
    },
    { type: "end" },
  ];
  const file = join(dir, "trace.ndjson");
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

interface MetricRecord {
  format: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  streaming: number;
  tool_call_count: number;
  cost: number;
}

describe("runParse", () => {
  it("derives metrics and tool calls from a captured trace", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    const traceFile = writeTrace(dir);

    store.insertRequest({
      id: "req-1",
      sessionId: "sess-1",
      provider: "anthropic",
      method: "POST",
      path: "/sess-1/anthropic/v1/messages",
      traceFile,
      startedAt: "2026-01-01T00:00:00Z",
    });
    store.finishRequest("req-1", {
      status: 200,
      latencyMs: 100,
      requestBytes: 50,
      responseBytes: 200,
      endedAt: "2026-01-01T00:00:01Z",
      error: null,
    });

    const summary = runParse(
      store,
      { "claude-3-5-sonnet-20241022": { inputPerMTok: 3, outputPerMTok: 15 } },
      { all: false },
    );
    store.close();

    expect(summary).toEqual({ total: 1, parsed: 1, failed: 0 });

    const db = new Database(join(dir, "aap.sqlite"));
    const metric = db
      .prepare("SELECT * FROM metrics WHERE request_id = ?")
      .get("req-1") as MetricRecord;
    const tools = db
      .prepare(
        "SELECT name FROM tool_calls WHERE request_id = ? ORDER BY ordinal",
      )
      .all("req-1") as { name: string }[];
    db.close();

    expect(metric.format).toBe("anthropic");
    expect(metric.model).toBe("claude-3-5-sonnet-20241022");
    expect(metric.input_tokens).toBe(10);
    expect(metric.output_tokens).toBe(25);
    expect(metric.stop_reason).toBe("tool_use");
    expect(metric.streaming).toBe(1);
    expect(metric.tool_call_count).toBe(1);
    expect(metric.cost).toBeCloseTo(10e-6 * 3 + 25e-6 * 15);
    expect(tools.map((t) => t.name)).toEqual(["get_weather"]);
  });

  it("is idempotent and skips already-parsed requests", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    const traceFile = writeTrace(dir);
    store.insertRequest({
      id: "req-1",
      sessionId: "sess-1",
      provider: "anthropic",
      method: "POST",
      path: "/x",
      traceFile,
      startedAt: "t0",
    });
    store.finishRequest("req-1", {
      status: 200,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      endedAt: "t1",
      error: null,
    });

    expect(runParse(store, {}, { all: false }).parsed).toBe(1);
    expect(runParse(store, {}, { all: false }).parsed).toBe(0);
    expect(runParse(store, {}, { all: true }).parsed).toBe(1);
    store.close();
  });
});
