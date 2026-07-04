import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Capture, RequestTrace } from "../capture/index.js";
import { handleApi } from "../api/index.js";
import { SessionRegistry, type SessionInfo } from "../session/index.js";
import type { Store } from "../store/index.js";
import type { RequestLogEntry, RequestLogger } from "./log.js";
import { parseRoute } from "./route.js";

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function createProxyServer(
  config: Config,
  registry: SessionRegistry,
  capture?: Capture,
  store?: Store,
  logger?: RequestLogger,
): http.Server {
  const providers = new Set(Object.keys(config.providers));
  return http.createServer((req, res) => {
    handle(req, res, config, providers, registry, capture, store, logger);
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  providers: ReadonlySet<string>,
  registry: SessionRegistry,
  capture?: Capture,
  store?: Store,
  logger?: RequestLogger,
): void {
  const rawUrl = req.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart);

  if (handleControl(req, res, pathname, registry, capture)) return;
  if (store && handleApi(req, res, pathname, store)) return;

  const route = parseRoute(pathname, providers);
  if (!route) {
    sendError(res, 404, `No provider route for "${pathname}"`);
    return;
  }

  const provider = config.providers[route.provider];
  if (!provider) {
    sendError(res, 404, `Unknown provider "${route.provider}"`);
    return;
  }

  const method = req.method ?? "GET";

  let trace: RequestTrace | undefined;
  if (capture) {
    const sessionId = route.sessionId ?? capture.nextUnattributedSession();
    trace = capture.begin({
      sessionId,
      requestId: randomUUID(),
      provider: route.provider,
      method,
      path: pathname + search,
      httpVersion: req.httpVersion,
      headers: req.headers,
      startedAt: Date.now(),
    });
  }

  forward(req, res, provider.upstream, route.upstreamPath + search, {
    trace,
    logger,
    meta: {
      sessionId: route.sessionId,
      provider: route.provider,
      method,
      path: route.upstreamPath,
    },
  });
}

function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  registry: SessionRegistry,
  capture?: Capture,
): boolean {
  if (pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return true;
  }
  if (pathname === "/_control/sessions") {
    if (req.method === "GET") {
      sendJson(res, 200, registry.list());
      return true;
    }
    if (req.method === "POST") {
      registerSession(req, res, registry, capture);
      return true;
    }
  }
  return false;
}

function registerSession(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry,
  capture?: Capture,
): void {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    let info: Partial<SessionInfo>;
    try {
      info = JSON.parse(body) as Partial<SessionInfo>;
    } catch (err) {
      sendError(res, 400, `Invalid session payload: ${(err as Error).message}`);
      return;
    }
    if (typeof info.id !== "string" || info.id.length === 0) {
      sendError(res, 400, "session 'id' is required");
      return;
    }
    const session: SessionInfo = {
      id: info.id,
      client: info.client,
      cwd: info.cwd,
      repo: info.repo ?? null,
      startedAt: info.startedAt ?? new Date().toISOString(),
    };
    registry.register(session);
    capture?.upsertSession(session);
    sendJson(res, 200, { ok: true });
  });
}

interface ForwardObs {
  trace?: RequestTrace;
  logger?: RequestLogger;
  meta: Omit<
    RequestLogEntry,
    "status" | "latencyMs" | "responseBytes" | "error"
  >;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  pathWithQuery: string,
  obs: ForwardObs,
): void {
  const { trace, logger, meta } = obs;
  const startedAt = Date.now();
  let status: number | null = null;
  let responseBytes = 0;
  let errorMessage: string | undefined;
  let logged = false;

  const emitLog = (): void => {
    if (!logger || logged) return;
    logged = true;
    logger({
      ...meta,
      status,
      latencyMs: Date.now() - startedAt,
      responseBytes,
      error: errorMessage,
    });
  };

  let base: URL;
  try {
    base = new URL(upstream);
  } catch {
    errorMessage = `Invalid upstream URL "${upstream}"`;
    sendError(res, 500, errorMessage);
    trace?.error("resolve", errorMessage);
    trace?.finish();
    emitLog();
    return;
  }

  const isHttps = base.protocol === "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  const fullPath = basePath + pathWithQuery;

  const headers: OutgoingHttpHeaders = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  headers["host"] = base.host;

  if (trace) {
    req.on("data", (chunk: Buffer) => trace.requestChunk(chunk));
  }

  const transport = isHttps ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      method: req.method,
      path: fullPath,
      headers,
    },
    (upstreamRes) => {
      status = upstreamRes.statusCode ?? 502;
      const outHeaders: OutgoingHttpHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP) delete outHeaders[name];
      trace?.response(status, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.on("data", (chunk: Buffer) => {
        responseBytes += chunk.length;
        trace?.responseChunk(chunk);
      });
      res.writeHead(status, upstreamRes.statusMessage, outHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (err) => {
    errorMessage = err.message;
    trace?.error("upstream", err.message);
    if (!res.headersSent) {
      sendError(res, 502, `Upstream request failed: ${err.message}`);
    } else {
      res.destroy();
    }
  });

  res.on("finish", () => {
    trace?.finish();
    emitLog();
  });
  res.on("close", () => {
    if (!res.writableFinished) upstreamReq.destroy();
    trace?.finish();
    emitLog();
  });

  req.pipe(upstreamReq);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}
