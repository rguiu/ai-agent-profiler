import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore } from "./index.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

interface RequestRecord {
  status: number;
  latency_ms: number;
  session_id: string;
  request_bytes: number;
  response_bytes: number;
}

interface SessionRecord {
  client: string | null;
  cwd: string | null;
  started_at: string | null;
}

describe("Store", () => {
  it("inserts a request and records its outcome", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({
      id: "s1",
      client: "claude",
      cwd: "/x",
      repo: "r",
      startedAt: "2026-01-01T00:00:00Z",
    });
    store.insertRequest({
      id: "r1",
      sessionId: "s1",
      provider: "anthropic",
      method: "POST",
      path: "/s1/anthropic/v1/messages",
      traceFile: "/t.ndjson",
      startedAt: "2026-01-01T00:00:00Z",
    });
    store.finishRequest("r1", {
      status: 200,
      latencyMs: 42,
      requestBytes: 10,
      responseBytes: 20,
      endedAt: "2026-01-01T00:00:01Z",
      error: null,
    });
    store.close();

    const db = new Database(join(dir, "aap.sqlite"));
    const req = db
      .prepare("SELECT * FROM requests WHERE id = ?")
      .get("r1") as RequestRecord;
    db.close();

    expect(req.status).toBe(200);
    expect(req.latency_ms).toBe(42);
    expect(req.session_id).toBe("s1");
    expect(req.response_bytes).toBe(20);
  });

  it("preserves existing session fields on a minimal re-upsert", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({
      id: "s1",
      client: "claude",
      cwd: "/x",
      repo: "r",
      startedAt: "t0",
    });
    store.upsertSession({ id: "s1", startedAt: "t1" });
    store.close();

    const db = new Database(join(dir, "aap.sqlite"));
    const ses = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get("s1") as SessionRecord;
    db.close();

    expect(ses.client).toBe("claude");
    expect(ses.cwd).toBe("/x");
    expect(ses.started_at).toBe("t0");
  });

  it("summarises tool usage, repeats, and context growth", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "s1", startedAt: "t0" });
    const requests: Array<[string, string, number]> = [
      ["r1", "2026-01-01T00:00:00Z", 100],
      ["r2", "2026-01-01T00:01:00Z", 250],
    ];
    for (const [id, started, inputTokens] of requests) {
      store.insertRequest({
        id,
        sessionId: "s1",
        provider: "deepseek",
        method: "POST",
        path: "/x",
        traceFile: "/t",
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
      store.upsertMetrics({
        requestId: id,
        format: "anthropic",
        model: "m",
        inputTokens,
        outputTokens: 10,
        stopReason: "tool_use",
        streaming: 1,
        toolCallCount: 1,
        cost: 0,
        parsedAt: "t",
      });
      store.replaceToolCalls(id, [
        { name: "read", arguments: '{"file":"/x"}' },
      ]);
    }

    const detail = store.getSession("s1");
    const global = store.globalToolUsage();
    store.close();

    expect(detail?.analysis.toolUsage).toEqual([{ name: "read", count: 2 }]);
    expect(detail?.analysis.repeated).toEqual([
      { name: "read", arguments: '{"file":"/x"}', count: 2 },
    ]);
    expect(detail?.analysis.growth.map((g) => g.input_tokens)).toEqual([
      100, 250,
    ]);
    expect(global).toEqual([{ name: "read", count: 2 }]);
  });
});
