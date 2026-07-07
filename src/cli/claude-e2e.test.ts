import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config/index.js";
import { createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore, type Store } from "../store/index.js";
import { FileCapture } from "../capture/index.js";
import { runParse } from "../parse/index.js";
import { buildProviderEnv } from "./run.js";

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

const ANTHROPIC_STREAMING_RESPONSE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514","role":"assistant","usage":{"input_tokens":150,"output_tokens":1,"cache_read_input_tokens":120}}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello! I can help."}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"Read"}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/src/main.ts\\"}"}}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}`,
  ``,
].join("\n");

function createAnthropicUpstream(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/v1/messages" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(ANTHROPIC_STREAMING_RESPONSE);
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              type: "message",
              model: "claude-sonnet-4-20250514",
              content: [{ type: "text", text: "non-streaming" }],
              usage: { input_tokens: 100, output_tokens: 20 },
              stop_reason: "end_turn",
            }),
          );
        }
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
}

interface Stack {
  proxyPort: number;
  store: Store;
  dir: string;
  config: Config;
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "aap-claude-e2e-"));
  const upstream = createAnthropicUpstream();
  const upstreamPort = await listen(upstream);

  const config: Config = {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir },
    optimize: {
      enabled: false,
      dedup: true,
      truncate: true,
      stablePrefix: true,
      pruneStale: true,
      suppressReread: true,
      collapseSystem: true,
      stripToolDefs: false,
      truncateThreshold: 4096,
      pruneAfterTurns: 6,
      suppressWithinTurns: 2,
      stripToolDefsAfter: 3, pruneUnusedTools: true, pruneUnusedToolsAfter: 10,
    },
    providers: { anthropic: { upstream: `http://127.0.0.1:${upstreamPort}` } },
    pricing: {
      "claude-sonnet-4-20250514": { inputPerMTok: 3, outputPerMTok: 15 },
    },
    throttle: { maxConcurrent: 8, maxQueued: 64, timeoutMs: 180000 },
  };
  const store = openStore(dir);
  const registry = new SessionRegistry();
  const capture = new FileCapture(store, dir, config.sessions.idleTimeoutMs);
  const proxy = createProxyServer(config, registry, capture, store);
  const proxyPort = await listen(proxy);

  cleanup.push(
    () =>
      new Promise<void>((r) => {
        upstream.closeAllConnections();
        upstream.close(() => r());
      }),
  );
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        proxy.closeAllConnections();
        proxy.close(() => r());
      }),
  );
  cleanup.push(() => store.close());
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

  return { proxyPort, store, dir, config };
}

describe("Claude Code end-to-end", () => {
  it("routes Claude Code traffic through the proxy with session attribution", async () => {
    const { proxyPort, dir, config } = await startStack();

    // Simulate what `aap run claude` does: set ANTHROPIC_BASE_URL
    const sessionId = "claude-test-session-1";
    const origin = `http://127.0.0.1:${proxyPort}`;
    const env = buildProviderEnv("claude", config, origin, sessionId);

    // Claude Code would use ANTHROPIC_BASE_URL to construct the full URL
    const baseUrl = env.ANTHROPIC_BASE_URL;
    expect(baseUrl).toBe(`${origin}/${sessionId}/anthropic`);

    // Send a streaming request as Claude Code would
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test-key-should-be-redacted",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        system: "You are a helpful assistant.",
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: { file_path: { type: "string" } },
            },
          },
        ],
        messages: [{ role: "user", content: "Read src/main.ts" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("message_start");
    expect(body).toContain("tool_use");

    // Wait for capture to finish writing
    await new Promise((r) => setTimeout(r, 100));

    // Verify the session was captured correctly
    const db = new Database(join(dir, "aap.sqlite"));
    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string } | undefined;
    expect(session).toBeDefined();
    expect(session!.id).toBe(sessionId);

    const request = db
      .prepare("SELECT * FROM requests WHERE session_id = ?")
      .get(sessionId) as {
      id: string;
      session_id: string;
      provider: string;
      status: number;
      ended_at: string | null;
    };
    expect(request.provider).toBe("anthropic");
    expect(request.status).toBe(200);
    expect(request.ended_at).not.toBeNull();
    db.close();
  });

  it("parses Anthropic streaming response into correct metrics and tool calls", async () => {
    const { proxyPort, store, dir, config } = await startStack();
    const sessionId = "claude-parse-test";
    const origin = `http://127.0.0.1:${proxyPort}`;
    const env = buildProviderEnv("claude", config, origin, sessionId);

    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-test",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 100));

    // Run parse (as `aap parse` would)
    const summary = await runParse(store, config.pricing, { all: false });
    expect(summary.parsed).toBe(1);
    expect(summary.failed).toBe(0);

    // Verify derived metrics
    const db = new Database(join(dir, "aap.sqlite"));
    const metric = db
      .prepare(
        "SELECT * FROM metrics WHERE request_id = (SELECT id FROM requests WHERE session_id = ?)",
      )
      .get(sessionId) as {
      format: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      stop_reason: string;
      streaming: number;
      tool_call_count: number;
      cost: number;
    };

    expect(metric.format).toBe("anthropic");
    expect(metric.model).toBe("claude-sonnet-4-20250514");
    expect(metric.input_tokens).toBe(150);
    expect(metric.output_tokens).toBe(42);
    expect(metric.cached_input_tokens).toBe(120);
    expect(metric.stop_reason).toBe("tool_use");
    expect(metric.streaming).toBe(1);
    expect(metric.tool_call_count).toBe(1);
    expect(metric.cost).toBeGreaterThan(0);

    // Verify tool call was extracted
    const toolCall = db
      .prepare(
        "SELECT * FROM tool_calls WHERE request_id = (SELECT id FROM requests WHERE session_id = ?)",
      )
      .get(sessionId) as {
      name: string;
      arguments: string;
      tool_id: string;
    };
    expect(toolCall.name).toBe("Read");
    expect(toolCall.arguments).toContain("/src/main.ts");
    expect(toolCall.tool_id).toBe("toolu_01");
    db.close();
  });

  it("redacts x-api-key from stored traces", async () => {
    const { proxyPort, dir, config } = await startStack();
    const sessionId = "claude-redact-test";
    const origin = `http://127.0.0.1:${proxyPort}`;
    const env = buildProviderEnv("claude", config, origin, sessionId);

    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-super-secret-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 100));

    // Read the raw trace file and verify the key is redacted
    const db = new Database(join(dir, "aap.sqlite"));
    const request = db
      .prepare("SELECT trace_file FROM requests WHERE session_id = ?")
      .get(sessionId) as { trace_file: string };
    db.close();

    const { readFileSync } = await import("node:fs");
    const trace = readFileSync(request.trace_file, "utf8");
    expect(trace).not.toContain("sk-ant-super-secret-key");
    expect(trace).toContain("[REDACTED]");
  });

  it("handles non-streaming Anthropic responses", async () => {
    const { proxyPort, store, dir, config } = await startStack();
    const sessionId = "claude-non-stream";
    const origin = `http://127.0.0.1:${proxyPort}`;
    const env = buildProviderEnv("claude", config, origin, sessionId);

    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-test",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { type: string }).type).toBe("message");

    await new Promise((r) => setTimeout(r, 100));

    const summary = await runParse(store, config.pricing, { all: false });
    expect(summary.parsed).toBe(1);

    const db = new Database(join(dir, "aap.sqlite"));
    const metric = db
      .prepare(
        "SELECT * FROM metrics WHERE request_id = (SELECT id FROM requests WHERE session_id = ?)",
      )
      .get(sessionId) as {
      format: string;
      streaming: number;
      input_tokens: number;
      output_tokens: number;
    };
    expect(metric.format).toBe("anthropic");
    expect(metric.streaming).toBe(0);
    expect(metric.input_tokens).toBe(100);
    expect(metric.output_tokens).toBe(20);
    db.close();
  });
});
