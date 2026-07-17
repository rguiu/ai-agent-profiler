import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/index.js";
import { openSearchStore, type SearchStore } from "./search-store.js";
import { runIndex } from "./indexer.js";

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-indexer-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = dirs.pop())) rmSync(dir, { recursive: true, force: true });
});

function writeTrace(dir: string, sessionId: string, requestId: string): string {
  const traceDir = join(dir, "traces", sessionId);
  mkdirSync(traceDir, { recursive: true });
  const file = join(traceDir, `${requestId}.ndjson`);
  const requestBody = {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: `find the flaky ${requestId} test` }],
  };
  const responseBody = {
    type: "message",
    model: "claude-sonnet-4",
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
    content: [{ type: "text", text: `the ${requestId} test races on startup` }],
  };
  const events = [
    { type: "request", ts: 1, headers: { "content-type": "application/json" } },
    {
      type: "request_body",
      ts: 2,
      data: Buffer.from(JSON.stringify(requestBody)).toString("base64"),
    },
    {
      type: "response",
      ts: 3,
      status: 200,
      headers: { "content-type": "application/json" },
    },
    {
      type: "response_body",
      ts: 4,
      data: Buffer.from(JSON.stringify(responseBody)).toString("base64"),
    },
    { type: "end", ts: 5 },
  ];
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n"));
  return file;
}

function seedRequest(
  store: Store,
  dir: string,
  sessionId: string,
  requestId: string,
  opts: { parsed?: boolean; traceFile?: string } = {},
): void {
  store.upsertSession({
    id: sessionId,
    client: "claude",
    cwd: "/home/dev/widget",
    repo: "github.com/acme/widget",
    startedAt: "2026-07-17T09:00:00.000Z",
    meta: null,
  });
  const traceFile = opts.traceFile ?? writeTrace(dir, sessionId, requestId);
  store.insertRequest({
    id: requestId,
    sessionId,
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages",
    traceFile,
    startedAt: "2026-07-17T10:00:00.000Z",
  });
  store.finishRequest(requestId, {
    status: 200,
    latencyMs: 1200,
    requestBytes: 100,
    responseBytes: 200,
    endedAt: "2026-07-17T10:00:01.200Z",
    error: null,
  });
  if (opts.parsed !== false) {
    store.upsertMetrics({
      requestId,
      format: "anthropic",
      model: "claude-sonnet-4",
      inputTokens: 10,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      outputTokens: 5,
      stopReason: "end_turn",
      streaming: 0,
      toolCallCount: 0,
      cost: null,
      parsedAt: "2026-07-17T10:00:02.000Z",
      messageCount: 1,
      systemTokens: 0,
      toolsDefined: 0,
      toolsTokens: 0,
      kind: "main",
    });
  }
}

function openBoth(dir: string): { store: Store; search: SearchStore } {
  return { store: openStore(dir), search: openSearchStore(dir) };
}

describe("runIndex", () => {
  it("indexes parsed requests and is idempotent", async () => {
    const dir = tmpDir();
    const { store, search } = openBoth(dir);
    seedRequest(store, dir, "sess-1", "req-1");
    seedRequest(store, dir, "sess-1", "req-2");

    const first = await runIndex(store, search, {});
    expect(first.indexed).toBe(2);
    expect(first.failed).toBe(0);
    expect(first.chunks).toBeGreaterThan(0);

    const second = await runIndex(store, search, {});
    expect(second.total).toBe(0);
    expect(second.indexed).toBe(0);

    const hits = search.search({ query: "flaky req-1" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.session_id).toBe("sess-1");
    expect(hits[0]?.model).toBe("claude-sonnet-4");
    expect(hits[0]?.repo).toBe("github.com/acme/widget");

    search.close();
    store.close();
  });

  it("skips unparsed requests until metrics exist", async () => {
    const dir = tmpDir();
    const { store, search } = openBoth(dir);
    seedRequest(store, dir, "sess-1", "req-1", { parsed: false });

    const summary = await runIndex(store, search, {});
    expect(summary.total).toBe(0);

    search.close();
    store.close();
  });

  it("records failures for unreadable traces and does not retry them", async () => {
    const dir = tmpDir();
    const { store, search } = openBoth(dir);
    seedRequest(store, dir, "sess-1", "req-1", {
      traceFile: join(dir, "traces", "sess-1", "missing.ndjson"),
    });

    const first = await runIndex(store, search, {});
    expect(first.failed).toBe(1);
    expect(search.status().failedRequests).toBe(1);

    const second = await runIndex(store, search, {});
    expect(second.total).toBe(0);

    search.close();
    store.close();
  });

  it("re-indexes everything with all=true", async () => {
    const dir = tmpDir();
    const { store, search } = openBoth(dir);
    seedRequest(store, dir, "sess-1", "req-1");

    await runIndex(store, search, {});
    const before = search.status().chunks;
    const again = await runIndex(store, search, { all: true });
    expect(again.indexed).toBe(1);
    expect(search.status().chunks).toBe(before);

    search.close();
    store.close();
  });

  it("honors the batch limit", async () => {
    const dir = tmpDir();
    const { store, search } = openBoth(dir);
    seedRequest(store, dir, "sess-1", "req-1");
    seedRequest(store, dir, "sess-1", "req-2");
    seedRequest(store, dir, "sess-1", "req-3");

    const summary = await runIndex(store, search, { limit: 2 });
    expect(summary.indexed).toBe(2);
    const rest = await runIndex(store, search, { limit: 2 });
    expect(rest.indexed).toBe(1);

    search.close();
    store.close();
  });
});
