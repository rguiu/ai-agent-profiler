import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config/index.js";
import { createProxyServer } from "../proxy/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore } from "../store/index.js";
import { FileCapture } from "./index.js";

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

const upstreamHandler: http.RequestListener = (req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`path=${req.url} body=${body}`);
  });
};

interface Stack {
  proxyPort: number;
  dbPath: string;
  tracesDir: string;
}

async function startStack(): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "aap-cap-"));
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);

  const config: Config = {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir },
    providers: { test: { upstream: `http://127.0.0.1:${upstreamPort}` } },
    pricing: {},
  };
  const store = openStore(dir);
  const capture = new FileCapture(store, dir, config.sessions.idleTimeoutMs);
  const proxy = createProxyServer(config, new SessionRegistry(), capture);
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

  return { proxyPort, dbPath: join(dir, "aap.sqlite"), tracesDir: dir };
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface FinishedRequest {
  id: string;
  session_id: string;
  status: number;
  latency_ms: number;
  request_bytes: number;
  response_bytes: number;
  trace_file: string;
  ended_at: string | null;
}

function readFinishedRequest(dbPath: string): FinishedRequest | undefined {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare("SELECT * FROM requests WHERE ended_at IS NOT NULL LIMIT 1")
      .get() as FinishedRequest | undefined;
    return row;
  } finally {
    db.close();
  }
}

interface TraceEvent {
  type: string;
  headers?: Record<string, string | string[]>;
  status?: number;
}

function readTrace(traceFile: string): TraceEvent[] | undefined {
  let content: string;
  try {
    content = readFileSync(traceFile, "utf8");
  } catch {
    return undefined;
  }
  if (!content.includes('"type":"end"')) return undefined;
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as TraceEvent);
}

describe("FileCapture end-to-end", () => {
  it("records a request/response and redacts secrets", async () => {
    const { proxyPort, dbPath } = await startStack();

    const res = await fetch(`http://127.0.0.1:${proxyPort}/sess-1/test/echo`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "x-api-key": "sk-123" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    await res.text();

    const row = await waitFor(() => readFinishedRequest(dbPath));
    expect(row.session_id).toBe("sess-1");
    expect(row.status).toBe(200);
    expect(row.request_bytes).toBe(5);
    expect(row.response_bytes).toBeGreaterThan(0);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);

    const events = await waitFor(() => readTrace(row.trace_file));
    const request = events.find((e) => e.type === "request");
    const response = events.find((e) => e.type === "response");
    expect(request?.headers?.["authorization"]).toBe("[REDACTED]");
    expect(request?.headers?.["x-api-key"]).toBe("[REDACTED]");
    expect(response?.status).toBe(200);
    expect(events.some((e) => e.type === "response_body")).toBe(true);
    expect(events.some((e) => e.type === "end")).toBe(true);
  });

  it("assigns an unattributed session id when no session is in the path", async () => {
    const { proxyPort, dbPath } = await startStack();

    await (
      await fetch(`http://127.0.0.1:${proxyPort}/test/echo`, {
        method: "POST",
        body: "x",
      })
    ).text();

    const row = await waitFor(() => readFinishedRequest(dbPath));
    expect(row.session_id.startsWith("unattributed-")).toBe(true);
  });
});
