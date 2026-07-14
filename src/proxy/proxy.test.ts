import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.js";
import { SessionRegistry } from "../session/index.js";
import { openStore, type Store } from "../store/index.js";
import { createProxyServer } from "./index.js";
import type { RequestLogEntry } from "./index.js";

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

const upstreamHandler: http.RequestListener = (req, res) => {
  if (req.url === "/echo") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`method=${req.method} path=${req.url} body=${body}`);
    });
    return;
  }
  if (req.url === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 0\n\n");
    setTimeout(() => {
      res.write("data: 1\n\n");
      res.end();
    }, 10);
    return;
  }
  res.writeHead(404);
  res.end("nope");
};

async function startStack(
  logger?: (entry: RequestLogEntry) => void,
): Promise<{ proxyPort: number }> {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  servers.push(upstream);

  const config = buildConfig(upstreamPort);
  const proxy = createProxyServer(
    config,
    new SessionRegistry(),
    undefined,
    undefined,
    logger,
  );
  const proxyPort = await listen(proxy);
  servers.push(proxy);
  return { proxyPort };
}

function buildConfig(upstreamPort: number): Config {
  return {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir: "data" },
    providers: { test: { upstream: `http://127.0.0.1:${upstreamPort}` } },
    pricing: {},
    throttle: { maxConcurrent: 8, maxQueued: 64, timeoutMs: 180000 },
  };
}

afterEach(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.length = 0;
});

describe("proxy passthrough", () => {
  it("forwards method, path, and body on a session route", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/sess-1/test/echo`, {
      method: "POST",
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("method=POST path=/echo body=hello");
  });

  it("forwards an unattributed route", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/test/echo`, {
      method: "POST",
      body: "x",
    });
    expect(await res.text()).toContain("path=/echo");
  });

  it("streams the response through unchanged", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/sess/test/stream`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: 0\n\ndata: 1\n\n");
  });

  it("returns 404 for an unknown provider", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/sess/nope/echo`);
    expect(res.status).toBe(404);
  });

  it("reports each request to the logger", async () => {
    const entries: RequestLogEntry[] = [];
    const { proxyPort } = await startStack((e) => entries.push(e));
    await (
      await fetch(`http://127.0.0.1:${proxyPort}/sess-1/test/echo`, {
        method: "POST",
        body: "hello",
      })
    ).text();

    await new Promise((r) => setTimeout(r, 50));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.sessionId).toBe("sess-1");
    expect(entry?.provider).toBe("test");
    expect(entry?.method).toBe("POST");
    expect(entry?.path).toBe("/echo");
    expect(entry?.status).toBe(200);
    expect(entry?.responseBytes).toBeGreaterThan(0);
    expect(entry?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});


describe("control endpoint", () => {
  it("registers and lists sessions", async () => {
    const { proxyPort } = await startStack();
    const base = `http://127.0.0.1:${proxyPort}/_control/sessions`;
    const post = await fetch(base, {
      method: "POST",
      body: JSON.stringify({ id: "s1", cwd: "/tmp" }),
    });
    expect(post.status).toBe(200);

    const list = (await (await fetch(base)).json()) as { id: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("s1");
  });

  it("rejects a session payload without an id", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_control/sessions`, {
      method: "POST",
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    expect(res.status).toBe(400);
  });

  it("reports health", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });
});
