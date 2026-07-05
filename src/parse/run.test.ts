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
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } })}`,
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
        "SELECT name, arguments FROM tool_calls WHERE request_id = ? ORDER BY ordinal",
      )
      .all("req-1") as { name: string; arguments: string | null }[];
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
    expect(tools[0]?.arguments).toBe('{"city":"Paris"}');
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

  it("correlates a tool result in a later request back to its tool call", () => {
    const dir = tmpDir();
    const store = openStore(dir);

    const noToolResponse = [
      `data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":30}}}`,
      ``,
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
      ``,
    ].join("\n");
    const write = (name: string, events: unknown[]): string => {
      const file = join(dir, name);
      writeFileSync(
        file,
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      return file;
    };

    // r1 response calls tool_use id "t1"
    const r1 = write("r1.ndjson", [
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
    ]);
    // r2 request body carries the tool_result for "t1"
    const r2Body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "RESULT-OUTPUT",
            },
          ],
        },
      ],
    });
    const r2 = write("r2.ndjson", [
      { type: "request", headers: {} },
      { type: "request_body", data: Buffer.from(r2Body).toString("base64") },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
      {
        type: "response_body",
        data: Buffer.from(noToolResponse).toString("base64"),
      },
      { type: "end" },
    ]);

    for (const [id, file, started] of [
      ["req-1", r1, "2026-01-01T00:00:00Z"],
      ["req-2", r2, "2026-01-01T00:01:00Z"],
    ] as const) {
      store.insertRequest({
        id,
        sessionId: "s1",
        provider: "anthropic",
        method: "POST",
        path: "/x",
        traceFile: file,
        startedAt: started,
      });
      store.finishRequest(id, {
        status: 200,
        latencyMs: 1,
        requestBytes: 1,
        responseBytes: 1,
        endedAt: started,
        error: null,
      });
    }

    runParse(store, {}, { all: false });

    const db = new Database(join(dir, "aap.sqlite"));
    const row = db
      .prepare(
        "SELECT result_bytes, result_tokens FROM tool_calls WHERE tool_id = ?",
      )
      .get("t1") as {
      result_bytes: number | null;
      result_tokens: number | null;
    };
    db.close();
    store.close();

    expect(row.result_bytes).toBe(Buffer.byteLength("RESULT-OUTPUT"));
    expect(row.result_tokens).toBe(Math.ceil("RESULT-OUTPUT".length / 4));
  });
});
