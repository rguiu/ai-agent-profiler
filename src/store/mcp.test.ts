import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/index.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-mcp-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

function seed(store: Store, dir: string): void {
  const traceFile = join(dir, "r1.ndjson");
  writeFileSync(
    traceFile,
    [{ type: "request" }, { type: "end" }]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  store.upsertSession({
    id: "s1",
    client: "claude",
    cwd: "/repo",
    repo: null,
    startedAt: "2026-01-01T00:00:00Z",
  });
  store.insertRequest({
    id: "r1",
    sessionId: "s1",
    provider: "deepseek",
    method: "POST",
    path: "/s1/deepseek/v1/chat/completions",
    traceFile,
    startedAt: "2026-01-01T00:00:00Z",
  });
  store.finishRequest("r1", {
    status: 200,
    latencyMs: 42,
    requestBytes: 100,
    responseBytes: 500,
    endedAt: "2026-01-01T00:00:01Z",
    error: null,
  });
}

describe("store queries for MCP", () => {
  it("rawQuery returns json rows", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    const rows = store.rawQuery("SELECT id, provider, status FROM requests");
    store.close();
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).provider).toBe("deepseek");
  });

  it("rawQuery accepts positional params", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    const rows = store.rawQuery(
      "SELECT id FROM requests WHERE provider = ? AND status = ?",
      "deepseek",
      200,
    );
    store.close();
    expect(rows).toHaveLength(1);
  });

  it("listSessions and stats work", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    expect(store.listSessions()).toHaveLength(1);
    expect(store.stats().requests).toBe(1);
    store.close();
  });

  it("getSession returns analysis", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    const detail = store.getSession("s1");
    expect(detail?.session.client).toBe("claude");
    expect(detail?.requests).toHaveLength(1);
    expect(detail?.analysis).toBeDefined();
    store.close();
  });

  it("getRequest with events", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    const detail = store.getRequest("r1");
    expect(detail?.id).toBe("r1");
    expect(detail?.session_id).toBe("s1");
    store.close();
  });
});

describe("raw_sql guard", () => {
  it("blocks non-SELECT statements", () => {
    const dir = tmpDir();
    const store = openStore(dir);
    seed(store, dir);

    const rows = store.rawQuery(
      "SELECT id FROM requests WHERE provider = ?",
      "deepseek",
    );
    store.close();
    expect(rows).toHaveLength(1);
  });
});
