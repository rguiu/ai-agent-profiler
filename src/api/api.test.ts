import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.js";
import { createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore, type Store } from "../store/index.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup.length = 0;
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

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
    repo: "git@example:repo",
    startedAt: "2026-01-01T00:00:00Z",
  });
  store.insertRequest({
    id: "r1",
    sessionId: "s1",
    provider: "anthropic",
    method: "POST",
    path: "/s1/anthropic/v1/messages",
    traceFile,
    startedAt: "2026-01-01T00:00:00Z",
  });
  store.finishRequest("r1", {
    status: 200,
    latencyMs: 120,
    requestBytes: 30,
    responseBytes: 400,
    endedAt: "2026-01-01T00:00:01Z",
    error: null,
  });
  store.upsertMetrics({
    requestId: "r1",
    format: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    inputTokens: 100,
    outputTokens: 50,
    stopReason: "tool_use",
    streaming: 1,
    toolCallCount: 1,
    cost: 0.00105,
    parsedAt: "2026-01-01T00:00:02Z",
  });
  store.replaceToolCalls("r1", [
    { name: "run_bash", arguments: '{"cmd":"ls"}' },
  ]);
}

async function startStack(): Promise<{ port: number }> {
  const dir = mkdtempSync(join(tmpdir(), "aap-api-"));
  const store = openStore(dir);
  seed(store, dir);

  const config: Config = {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir },
    providers: { test: { upstream: "http://127.0.0.1:1" } },
    pricing: {},
  };
  const server = createProxyServer(
    config,
    new SessionRegistry(),
    undefined,
    store,
  );
  const port = await listen(server);

  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  cleanup.push(() => store.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { port };
}

describe("read API", () => {
  it("lists sessions with rolled-up metrics", async () => {
    const { port } = await startStack();
    const sessions = (await (
      await fetch(`http://127.0.0.1:${port}/sessions`)
    ).json()) as Array<{
      id: string;
      request_count: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
      tool_calls: number;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("s1");
    expect(sessions[0]?.request_count).toBe(1);
    expect(sessions[0]?.input_tokens).toBe(100);
    expect(sessions[0]?.output_tokens).toBe(50);
    expect(sessions[0]?.tool_calls).toBe(1);
    expect(sessions[0]?.cost).toBeCloseTo(0.00105);
  });

  it("returns session detail with its requests", async () => {
    const { port } = await startStack();
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/sessions/s1`)
    ).json()) as {
      session: { id: string; client: string };
      requests: Array<{ id: string; model: string; status: number }>;
    };
    expect(detail.session.id).toBe("s1");
    expect(detail.session.client).toBe("claude");
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests[0]?.model).toBe("claude-3-5-sonnet-20241022");
    expect(detail.requests[0]?.status).toBe(200);
  });

  it("404s for an unknown session", async () => {
    const { port } = await startStack();
    const res = await fetch(`http://127.0.0.1:${port}/sessions/nope`);
    expect(res.status).toBe(404);
  });

  it("returns request detail with tool calls", async () => {
    const { port } = await startStack();
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/requests/r1`)
    ).json()) as {
      id: string;
      model: string;
      cost: number;
      toolCalls: Array<{ ordinal: number; name: string; arguments: string }>;
      events?: unknown[];
    };
    expect(detail.id).toBe("r1");
    expect(detail.model).toBe("claude-3-5-sonnet-20241022");
    expect(detail.toolCalls).toEqual([
      { ordinal: 0, name: "run_bash", arguments: '{"cmd":"ls"}' },
    ]);
    expect(detail.events).toBeUndefined();
  });

  it("includes raw trace events when ?events=1", async () => {
    const { port } = await startStack();
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/requests/r1?events=1`)
    ).json()) as { events: Array<{ type: string }> };
    expect(detail.events.map((e) => e.type)).toEqual(["request", "end"]);
  });

  it("reports aggregate stats", async () => {
    const { port } = await startStack();
    const stats = (await (
      await fetch(`http://127.0.0.1:${port}/stats`)
    ).json()) as {
      sessions: number;
      requests: number;
      input_tokens: number;
      cost: number;
    };
    expect(stats.sessions).toBe(1);
    expect(stats.requests).toBe(1);
    expect(stats.input_tokens).toBe(100);
    expect(stats.cost).toBeCloseTo(0.00105);
  });

  it("exposes global tool usage and per-session analysis", async () => {
    const { port } = await startStack();
    const tools = (await (
      await fetch(`http://127.0.0.1:${port}/tools`)
    ).json()) as Array<{ name: string; count: number }>;
    expect(tools).toEqual([{ name: "run_bash", count: 1 }]);

    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/sessions/s1`)
    ).json()) as {
      analysis: {
        toolUsage: Array<{ name: string; count: number }>;
        repeated: unknown[];
        growth: unknown[];
      };
    };
    expect(detail.analysis.toolUsage).toEqual([{ name: "run_bash", count: 1 }]);
    expect(detail.analysis.growth).toHaveLength(1);
    expect(detail.analysis.repeated).toEqual([]);
  });

  it("rejects non-GET methods", async () => {
    const { port } = await startStack();
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });
});
