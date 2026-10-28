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
import { FileCapture, captureError } from "./index.js";

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

async function startStack(opts: { ollama?: boolean } = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "aap-cap-"));
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);

  const config: Config = {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir },
    providers: { test: { upstream: `http://127.0.0.1:${upstreamPort}` } },
    pricing: {},
    throttle: { maxConcurrent: 8, maxQueued: 64, timeoutMs: 180000 },
    search: { enabled: false, intervalMs: 5000, batchSize: 50 },
  };
  if (opts.ollama) {
    config.providers.ollama = { upstream: `http://127.0.0.1:${upstreamPort}` };
  }
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

  return {
    proxyPort,
    dbPath: join(dir, "aap.sqlite"),
    tracesDir: join(dir, "traces"),
  };
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
  path: string;
  error: string | null;
  ended_at: string | null;
}

function readRequests(dbPath: string): FinishedRequest[] {
  const db = new Database(dbPath);
  try {
    return db
      .prepare("SELECT * FROM requests ORDER BY started_at, id")
      .all() as FinishedRequest[];
  } finally {
    db.close();
  }
}

function readFinishedRequest(dbPath: string): FinishedRequest | undefined {
  return readRequests(dbPath).find((r) => r.ended_at !== null);
}

interface SessionRecord {
  id: string;
  client: string | null;
  cwd: string | null;
}

function readSession(dbPath: string, id: string): SessionRecord | undefined {
  const db = new Database(dbPath);
  try {
    return db
      .prepare("SELECT id, client, cwd FROM sessions WHERE id = ?")
      .get(id) as SessionRecord | undefined;
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

  it("attributes traffic to the session id the client advertises", async () => {
    const { proxyPort, dbPath } = await startStack();

    await (
      await fetch(`http://127.0.0.1:${proxyPort}/test/echo`, {
        method: "POST",
        headers: {
          "x-claude-code-session-id": "cc-3f2b8c1e",
          "user-agent": "claude-cli/2.1.13 (external, cli)",
        },
        body: "x",
      })
    ).text();

    const row = await waitFor(() => readFinishedRequest(dbPath));
    expect(row.session_id).toBe("cc-3f2b8c1e");
    // The client is inferred from the request, since no launcher registered it.
    expect(readSession(dbPath, "cc-3f2b8c1e")?.client).toBe("claude");
  });

  it("keeps an explicit session path ahead of the client's own id", async () => {
    const { proxyPort, dbPath } = await startStack();

    await (
      await fetch(`http://127.0.0.1:${proxyPort}/pinned-1/test/echo`, {
        method: "POST",
        headers: { "x-claude-code-session-id": "cc-ignored" },
        body: "x",
      })
    ).text();

    const row = await waitFor(() => readFinishedRequest(dbPath));
    expect(row.session_id).toBe("pinned-1");
  });

  it("buckets unattributed traffic per client", async () => {
    const { proxyPort, dbPath } = await startStack();

    for (const ua of ["opencode/1.0.42", "pi/1.4.0"]) {
      await (
        await fetch(`http://127.0.0.1:${proxyPort}/test/echo`, {
          method: "POST",
          headers: { "user-agent": ua },
          body: "x",
        })
      ).text();
    }

    const rows = await waitFor(() => {
      const all = readRequests(dbPath).filter((r) => r.ended_at !== null);
      return all.length === 2 ? all : undefined;
    });
    const sessions = new Set(rows.map((r) => r.session_id));
    expect(sessions.size).toBe(2);
    expect(
      [...sessions].some((id) => id.startsWith("unattributed-opencode-")),
    ).toBe(true);
    expect([...sessions].some((id) => id.startsWith("unattributed-pi-"))).toBe(
      true,
    );
  });

  it("keeps capturing after the session's trace dir is deleted", async () => {
    const { proxyPort, dbPath, tracesDir } = await startStack();
    const send = async (body: string): Promise<void> => {
      await (
        await fetch(`http://127.0.0.1:${proxyPort}/sess-1/test/echo`, {
          method: "POST",
          body,
        })
      ).text();
    };

    await send("a");
    const first = await waitFor(() => readFinishedRequest(dbPath));
    expect(await waitFor(() => readTrace(first.trace_file))).toBeDefined();

    // `aap sessions rm` / the UI can delete a session while the proxy is still
    // serving it; capture must recreate the directory instead of writing to a
    // path that no longer exists.
    rmSync(join(tracesDir, "sess-1"), { recursive: true, force: true });

    await send("b");
    const second = await waitFor(() => {
      const rows = readRequests(dbPath);
      return rows.length === 2 ? rows[1] : undefined;
    });
    expect(second.id).not.toBe(first.id);
    expect(second.error).toBeNull();

    const events = await waitFor(() => readTrace(second.trace_file));
    expect(events.some((e) => e.type === "end")).toBe(true);
  });

  it("proxies ollama control-plane calls without recording a request", async () => {
    const { proxyPort, dbPath } = await startStack({ ollama: true });

    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/tags`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("path=/api/tags");

    await (
      await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        body: "q",
      })
    ).text();

    const rows = await waitFor(() => {
      const all = readRequests(dbPath);
      return all.length > 0 ? all : undefined;
    });
    expect(rows.map((r) => r.path)).toEqual(["/v1/chat/completions"]);
  });
});

describe("captureError", () => {
  it("passes the request error through when the trace was written", () => {
    expect(captureError(null, null)).toBeNull();
    expect(captureError(null, "upstream")).toBe("upstream");
  });

  it("prefixes write failures and keeps the request error", () => {
    const writeError = new Error("ENOENT: no such file or directory");
    expect(captureError(writeError, null)).toBe(
      "capture: ENOENT: no such file or directory",
    );
    expect(captureError(writeError, "upstream")).toBe(
      "capture: ENOENT: no such file or directory; upstream",
    );
  });
});
