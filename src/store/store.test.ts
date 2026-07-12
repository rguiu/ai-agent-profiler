import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openStore, _isReadOnlyQuery } from "./index.js";

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

describe("isReadOnlyQuery", () => {
  it("allows plain SELECT statements", () => {
    expect(_isReadOnlyQuery("SELECT * FROM sessions")).toBe(true);
    expect(_isReadOnlyQuery("  SELECT id FROM requests  ")).toBe(true);
    expect(_isReadOnlyQuery("SELECT * FROM sessions WHERE id = 'x';")).toBe(
      true,
    );
  });

  it("rejects multi-statement injections", () => {
    expect(_isReadOnlyQuery("SELECT 1; DROP TABLE sessions")).toBe(false);
    expect(
      _isReadOnlyQuery("SELECT 1; INSERT INTO sessions VALUES ('x')"),
    ).toBe(false);
  });

  it("rejects write keywords embedded in the query", () => {
    expect(_isReadOnlyQuery("SELECT * FROM x; DELETE FROM y")).toBe(false);
    expect(_isReadOnlyQuery("SELECT 1 UNION ALTER TABLE x ADD z")).toBe(false);
    expect(_isReadOnlyQuery("SELECT ATTACH DATABASE 'x' AS y")).toBe(false);
  });

  it("rejects non-SELECT statements", () => {
    expect(_isReadOnlyQuery("INSERT INTO sessions VALUES ('x')")).toBe(false);
    expect(_isReadOnlyQuery("UPDATE sessions SET id = 'x'")).toBe(false);
    expect(_isReadOnlyQuery("DROP TABLE sessions")).toBe(false);
    expect(_isReadOnlyQuery("PRAGMA journal_mode = DELETE")).toBe(false);
  });

  it("allows keywords inside string literals (no false positives)", () => {
    expect(
      _isReadOnlyQuery("SELECT * FROM requests WHERE path LIKE '%DELETE%'"),
    ).toBe(true);
    expect(
      _isReadOnlyQuery("SELECT * FROM requests WHERE method = 'UPDATE'"),
    ).toBe(true);
    expect(
      _isReadOnlyQuery("SELECT * FROM sessions WHERE cwd = '/tmp/DROP TABLE'"),
    ).toBe(true);
  });
});

describe("openStore migrations", () => {
  it("upgrades a pre-tool_id database without error", () => {
    const dir = tmpDir();
    // Simulate an old database: tool_calls lacking the newer columns.
    const legacy = new Database(join(dir, "aap.sqlite"));
    legacy.exec(`
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL
      );
    `);
    legacy.close();

    expect(() => openStore(dir).close()).not.toThrow();

    const db = new Database(join(dir, "aap.sqlite"));
    const columns = db.prepare("PRAGMA table_info(tool_calls)").all() as {
      name: string;
    }[];
    const indexes = db.prepare("PRAGMA index_list(tool_calls)").all() as {
      name: string;
    }[];
    db.close();

    const names = columns.map((c) => c.name);
    expect(names).toContain("tool_id");
    expect(names).toContain("arguments");
    expect(names).toContain("result_tokens");
    expect(indexes.map((i) => i.name)).toContain("idx_tool_calls_tool_id");
  });
});

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

  it("resolves a session id by prefix and deletes a session", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "abcdef12-3456", startedAt: "t" });
    store.insertRequest({
      id: "r1",
      sessionId: "abcdef12-3456",
      provider: "deepseek",
      method: "POST",
      path: "/x",
      traceFile: "/t",
      startedAt: "t",
    });
    store.finishRequest("r1", {
      status: 200,
      latencyMs: 1,
      requestBytes: 1,
      responseBytes: 1,
      endedAt: "t",
      error: null,
    });

    expect(store.resolveSessionId("abcdef12")).toBe("abcdef12-3456");
    expect(store.resolveSessionId("zzz")).toBeUndefined();

    store.deleteSession("abcdef12-3456");
    const remaining = store.rawQuery(
      "SELECT COUNT(*) AS c FROM requests",
    ) as Array<{ c: number }>;
    store.close();
    expect(remaining[0]?.c).toBe(0);
  });

  it("finds session ids by metadata", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "a", startedAt: "t", meta: { task: "fix-bug" } });
    store.upsertSession({ id: "b", startedAt: "t", meta: { task: "fix-bug" } });
    store.upsertSession({ id: "c", startedAt: "t", meta: { task: "explain" } });
    store.upsertSession({ id: "d", startedAt: "t" });
    const ids = store.sessionIdsByMeta("task", "fix-bug").sort();
    store.close();
    expect(ids).toEqual(["a", "b"]);
  });

  it("merges a patch into session metadata", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({
      id: "s1",
      startedAt: "t",
      meta: { task: "fix-bug", agent: "opencode" },
    });
    expect(store.updateSessionMeta("s1", { verify: "pass" })).toBe(true);
    expect(store.updateSessionMeta("missing", { verify: "pass" })).toBe(false);
    const detail = store.getSession("s1");
    store.close();
    expect(detail?.session.meta).toEqual({
      task: "fix-bug",
      agent: "opencode",
      verify: "pass",
    });
  });

  it("stores and reads back session metadata", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({
      id: "s1",
      client: "opencode",
      startedAt: "t0",
      meta: { task: "explain", agent: "opencode" },
    });
    const detail = store.getSession("s1");
    store.close();
    expect(detail?.session.meta).toEqual({
      task: "explain",
      agent: "opencode",
    });
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

  it("recentSessions returns sessions for hydration", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({
      id: "s1",
      client: "claude",
      cwd: "/x",
      startedAt: "2026-01-01T00:00:00Z",
      meta: { task: "fix-bug" },
    });
    store.upsertSession({
      id: "s2",
      client: "opencode",
      cwd: "/y",
      startedAt: "2026-01-02T00:00:00Z",
    });
    const rows = store.recentSessions(10);
    store.close();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    const s1 = rows.find((r) => r.id === "s1")!;
    expect(s1.client).toBe("claude");
    expect(s1.meta).toContain("fix-bug");
  });

  it("rawQuery rejects non-SELECT queries", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    expect(() => store.rawQuery("DROP TABLE sessions")).toThrow(/read-only/);
    expect(() => store.rawQuery("SELECT 1; DROP TABLE sessions")).toThrow(
      /read-only/,
    );
    expect(() => store.rawQuery("DELETE FROM sessions")).toThrow(/read-only/);
    expect(() =>
      store.rawQuery(
        "SELECT * FROM sessions WHERE id IN (DELETE FROM sessions)",
      ),
    ).toThrow(/read-only/);
    // Valid queries should work
    expect(() => store.rawQuery("SELECT 1")).not.toThrow();
    expect(() => store.rawQuery("SELECT * FROM sessions")).not.toThrow();
    store.close();
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
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        stopReason: "tool_use",
        streaming: 1,
        toolCallCount: 1,
        cost: 0,
        parsedAt: "t",
        messageCount: 5,
        systemTokens: 30,
        toolsDefined: 2,
        toolsTokens: 200,
      });
      store.replaceToolCalls(id, [
        { id: `tool-${id}`, name: "read", arguments: '{"file":"/x"}' },
      ]);
    }

    const detail = store.getSession("s1");
    const global = store.globalToolUsage();
    store.close();

    expect(detail?.analysis.toolUsage).toEqual([
      { name: "read", count: 2, result_tokens: 0 },
    ]);
    expect(detail?.analysis.repeated).toEqual([
      { name: "read", arguments: '{"file":"/x"}', count: 2 },
    ]);
    expect(detail?.analysis.growth.map((g) => g.input_tokens)).toEqual([
      100, 250,
    ]);
    expect(global).toEqual([{ name: "read", count: 2, result_tokens: 0 }]);
  });
});

describe("optimize actions", () => {
  it("records per-strategy totals and exposes them on the session", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "s1", startedAt: "t" });
    store.recordOptimizeActions("s1", [
      { type: "prune_stale", tokensSaved: 100 },
      { type: "prune_stale", tokensSaved: 50 },
      { type: "collapse_system", tokensSaved: 200 },
    ]);

    expect(store.getOptimizeActions("s1")).toEqual([
      { type: "collapse_system", count: 1, tokens_saved: 200 },
      { type: "prune_stale", count: 2, tokens_saved: 150 },
    ]);
    expect(store.getSession("s1")?.optimize).toEqual([
      { type: "collapse_system", count: 1, tokens_saved: 200 },
      { type: "prune_stale", count: 2, tokens_saved: 150 },
    ]);
    store.close();
  });

  it("replaces prior totals (cumulative getActions is idempotent)", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "s1", startedAt: "t" });
    store.recordOptimizeActions("s1", [
      { type: "prune_stale", tokensSaved: 10 },
    ]);
    store.recordOptimizeActions("s1", [
      { type: "prune_stale", tokensSaved: 10 },
      { type: "prune_stale", tokensSaved: 40 },
    ]);
    expect(store.getOptimizeActions("s1")).toEqual([
      { type: "prune_stale", count: 2, tokens_saved: 50 },
    ]);
    store.close();
  });

  it("clears optimize actions when a session is deleted", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    store.upsertSession({ id: "s1", startedAt: "t" });
    store.recordOptimizeActions("s1", [
      { type: "prune_stale", tokensSaved: 10 },
    ]);
    store.deleteSession("s1");
    const rows = store.rawQuery(
      "SELECT COUNT(*) AS c FROM optimize_actions",
    ) as Array<{ c: number }>;
    store.close();
    expect(rows[0]?.c).toBe(0);
  });
});
