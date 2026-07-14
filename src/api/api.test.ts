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
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 50,
    stopReason: "tool_use",
    streaming: 1,
    toolCallCount: 1,
    cost: 0.00105,
    parsedAt: "2026-01-01T00:00:02Z",
    messageCount: 3,
    systemTokens: 40,
    toolsDefined: 2,
    toolsTokens: 120,
  });
  store.replaceToolCalls("r1", [
    { id: "call_1", name: "run_bash", arguments: '{"cmd":"ls"}' },
  ]);
}

async function startStack(): Promise<{
  port: number;
  store: Store;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "aap-api-"));
  const store = openStore(dir);
  seed(store, dir);

  const config: Config = {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir },
    optimize: {
      enabled: false,
      profile: "auto",
      dedup: true,
      truncate: true,
      stablePrefix: true,
      pruneStale: true,
      stableTruncate: false,
      shapeTestOutput: false,
      prefixProbe: false,
      frozenCompact: false,
      suppressReread: true,
      collapseSystem: true,
      truncateThreshold: 4096,
      pruneAfterTurns: 6,
      suppressWithinTurns: 2,
      pruneUnusedTools: true,
      insertBreakpoints: false,
      reorderVolatile: false,
      pruneUnusedToolsAfter: 10,
      compactThreshold: 60000,
      compactKeepTail: 20,
      stripTools: [],
      tailTruncate: true,
      optimizeOnCold: true,
      cacheTtlMs: 300_000,
      upgradeCacheTtl: "off",
    },
    providers: { test: { upstream: "http://127.0.0.1:1" } },
    pricing: {},
    throttle: { maxConcurrent: 8, maxQueued: 64, timeoutMs: 180000 },
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
  return { port, store, dir };
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
      prefixStability: {
        requests: number;
        longestStableRun: number;
        breakPoints: string[];
        dominantBreakSegment: string | null;
      };
    };
    expect(detail.session.id).toBe("s1");
    expect(detail.session.client).toBe("claude");
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests[0]?.model).toBe("claude-3-5-sonnet-20241022");
    expect(detail.requests[0]?.status).toBe(200);
    // No prefix rows persisted for this session yet (parse wasn't run) — the
    // summary should be present but empty, never throw.
    expect(detail.prefixStability).toEqual({
      requests: 0,
      longestStableRun: 0,
      breakPoints: [],
      dominantBreakSegment: null,
    });
  });

  it("includes a non-empty prefix-stability summary once prefixes are persisted", async () => {
    const { port, store } = await startStack();
    store.upsertPrefix({
      requestId: "r1",
      sessionId: "s1",
      systemHash: "sys1",
      toolsHash: "tools1",
      messageHashes: ["m1", "m2"],
      messageCount: 2,
    });
    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/sessions/s1`)
    ).json()) as {
      prefixStability: {
        requests: number;
        longestStableRun: number;
        breakPoints: string[];
        dominantBreakSegment: string | null;
      };
    };
    expect(detail.prefixStability.requests).toBe(1);
    expect(detail.prefixStability.breakPoints).toEqual([]);
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
      toolCalls: Array<{
        ordinal: number;
        name: string;
        arguments: string;
        tool_id: string | null;
        result_bytes: number | null;
        result_tokens: number | null;
      }>;
      events?: unknown[];
    };
    expect(detail.id).toBe("r1");
    expect(detail.model).toBe("claude-3-5-sonnet-20241022");
    expect(detail.toolCalls).toEqual([
      {
        ordinal: 0,
        name: "run_bash",
        arguments: '{"cmd":"ls"}',
        tool_id: "call_1",
        result_bytes: null,
        result_tokens: null,
      },
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
    ).json()) as Array<{ name: string; count: number; result_tokens: number }>;
    expect(tools).toEqual([{ name: "run_bash", count: 1, result_tokens: 0 }]);

    const detail = (await (
      await fetch(`http://127.0.0.1:${port}/sessions/s1`)
    ).json()) as {
      analysis: {
        toolUsage: Array<{
          name: string;
          count: number;
          result_tokens: number;
        }>;
        repeated: unknown[];
        growth: unknown[];
      };
    };
    expect(detail.analysis.toolUsage).toEqual([
      { name: "run_bash", count: 1, result_tokens: 0 },
    ]);
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

  it("breaks a request into its message stack", async () => {
    const { port, store, dir } = await startStack();
    const body = {
      model: "gpt-4o",
      tools: [
        { type: "function", function: { name: "bash", parameters: {} } },
        { type: "function", function: { name: "read", parameters: {} } },
      ],
      messages: [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "a.txt b.txt" },
      ],
    };
    const traceFile = join(dir, "r2.ndjson");
    writeFileSync(
      traceFile,
      [
        { type: "request", headers: { "content-type": "application/json" } },
        {
          type: "request_body",
          data: Buffer.from(JSON.stringify(body)).toString("base64"),
        },
        { type: "end" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    store.insertRequest({
      id: "r2",
      sessionId: "s1",
      provider: "openai",
      method: "POST",
      path: "/s1/openai/v1/chat/completions",
      traceFile,
      startedAt: "2026-01-01T00:00:05Z",
    });

    const stack = (await (
      await fetch(`http://127.0.0.1:${port}/requests/r2/messages`)
    ).json()) as {
      messageCount: number;
      tools: { count: number };
      totalsByRole: Array<{ role: string; count: number }>;
      messages: Array<{
        role: string;
        hasToolCalls: boolean;
        toolCallNames: string[];
        toolResultFor: string | null;
      }>;
    };
    expect(stack.messageCount).toBe(4);
    expect(stack.tools.count).toBe(2);
    expect(stack.totalsByRole.map((t) => t.role).sort()).toEqual([
      "assistant",
      "system",
      "tool",
      "user",
    ]);
    const assistant = stack.messages.find((m) => m.role === "assistant");
    expect(assistant?.hasToolCalls).toBe(true);
    expect(assistant?.toolCallNames).toContain("bash");
    expect(stack.messages.find((m) => m.role === "tool")?.toolResultFor).toBe(
      "c1",
    );
  });

  it("404s messages for an unknown request", async () => {
    const { port } = await startStack();
    const res = await fetch(`http://127.0.0.1:${port}/requests/nope/messages`);
    expect(res.status).toBe(404);
  });

  it("breaks down shell commands with categories", async () => {
    const { port, store } = await startStack();
    store.replaceToolCalls("r1", [
      { id: "b1", name: "bash", arguments: '{"command":"git status"}' },
      { id: "b2", name: "bash", arguments: '{"command":"ls -la"}' },
    ]);
    const rows = (await (
      await fetch(`http://127.0.0.1:${port}/commands`)
    ).json()) as Array<{ command: string; category: string; count: number }>;
    const byCommand = Object.fromEntries(rows.map((r) => [r.command, r]));
    expect(byCommand["git status"]?.category).toBe("vcs");
    expect(byCommand["ls"]?.category).toBe("search");
  });

  it("scopes command breakdown by session and 404s unknown ones", async () => {
    const { port, store } = await startStack();
    store.replaceToolCalls("r1", [
      { id: "b1", name: "bash", arguments: '{"command":"git commit -m x"}' },
    ]);
    const scoped = (await (
      await fetch(`http://127.0.0.1:${port}/commands?session=s1`)
    ).json()) as Array<{ command: string }>;
    expect(scoped.map((r) => r.command)).toContain("git commit");

    const res = await fetch(`http://127.0.0.1:${port}/commands?session=nope`);
    expect(res.status).toBe(404);
  });
});
