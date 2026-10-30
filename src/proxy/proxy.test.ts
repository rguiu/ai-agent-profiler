import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config/index.js";
import { SessionRegistry } from "../session/index.js";
import type { Store } from "../store/index.js";
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
  options: {
    providers?: (upstreamPort: number) => Config["providers"];
    store?: Store;
  } = {},
): Promise<{ proxyPort: number }> {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  servers.push(upstream);

  const config = buildConfig(upstreamPort, options.providers?.(upstreamPort));
  const proxy = createProxyServer(
    config,
    new SessionRegistry(),
    undefined,
    options.store,
    logger,
  );
  const proxyPort = await listen(proxy);
  servers.push(proxy);
  return { proxyPort };
}

function buildConfig(
  upstreamPort: number,
  providers?: Config["providers"],
): Config {
  return {
    server: { port: 0, host: "127.0.0.1" },
    sessions: { idleTimeoutMs: 300_000 },
    storage: { dir: "data" },
    providers: providers ?? {
      test: { upstream: `http://127.0.0.1:${upstreamPort}` },
    },
    pricing: {},
    throttle: { maxConcurrent: 8, maxQueued: 64, timeoutMs: 180000 },
    search: { enabled: false, intervalMs: 5000, batchSize: 50 },
  };
}

/** Request with an explicit `Host`, which fetch/undici won't let us set. */
function requestWithHost(
  port: number,
  path: string,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { host, "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
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

  it("answers the ollama CLI's `HEAD /` liveness probe", async () => {
    const { proxyPort } = await startStack();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
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

describe("ollama launch attribution", () => {
  const ollamaProviders = (upstreamPort: number): Config["providers"] => ({
    ollama: { upstream: `http://127.0.0.1:${upstreamPort}` },
  });

  async function registerAlias(
    proxyPort: number,
    id: string,
    alias: string,
  ): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_control/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, client: "opencode", meta: { alias } }),
    });
    expect(res.status).toBe(200);
  }

  it("attributes a prefix-less /v1 request to the alias it dialled", async () => {
    const entries: RequestLogEntry[] = [];
    const { proxyPort } = await startStack((entry) => entries.push(entry), {
      providers: ollamaProviders,
    });
    await registerAlias(proxyPort, "sess-alias", "sess-alias.localhost");

    await requestWithHost(
      proxyPort,
      "/v1/chat/completions",
      `sess-alias.localhost:${proxyPort}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBe("sess-alias");
    expect(entries[0]?.provider).toBe("ollama");
  });

  it("does not attribute shared-loopback traffic to a registered alias", async () => {
    const entries: RequestLogEntry[] = [];
    const { proxyPort } = await startStack((entry) => entries.push(entry), {
      providers: ollamaProviders,
    });
    await registerAlias(proxyPort, "sess-alias", "sess-alias.localhost");

    await requestWithHost(
      proxyPort,
      "/v1/chat/completions",
      `127.0.0.1:${proxyPort}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(entries[0]?.sessionId).toBeNull();
  });

  it("does not resurrect a pinned ollama session from the store", async () => {
    const entries: RequestLogEntry[] = [];
    const store = {
      recentSessions: () => [
        {
          id: "old-session",
          client: "opencode",
          cwd: null,
          repo: null,
          started_at: "2026-01-01T00:00:00Z",
          meta: JSON.stringify({ ollama: "1" }),
        },
      ],
    } as unknown as Store;
    const { proxyPort } = await startStack((entry) => entries.push(entry), {
      providers: ollamaProviders,
      store,
    });

    await requestWithHost(
      proxyPort,
      "/v1/chat/completions",
      `127.0.0.1:${proxyPort}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(entries[0]?.sessionId).toBeNull();
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
