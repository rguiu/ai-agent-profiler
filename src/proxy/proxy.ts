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
import { handleUi } from "../ui/index.js";
import type { RequestLogEntry, RequestLogger } from "./log.js";
import { forwardBedrock } from "./bedrock.js";
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

export interface ProxyState {
  activeBedrockSession: string | null;
}

export function createProxyServer(
  config: Config,
  registry: SessionRegistry,
  capture?: Capture,
  store?: Store,
  logger?: RequestLogger,
): http.Server {
  const providers = new Set(Object.keys(config.providers));
  // Initialize activeBedrockSession from hydrated registry (survives proxy restart)
  let initial: string | null = null;
  if (providers.has("bedrock")) {
    for (const s of registry.list()) {
      if (s.meta?.bedrock === "1") initial = s.id;
    }
  }
  const state: ProxyState = { activeBedrockSession: initial };
  return http.createServer((req, res) => {
    handle(req, res, config, providers, registry, state, capture, store, logger);
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  providers: ReadonlySet<string>,
  registry: SessionRegistry,
  state: ProxyState,
  capture?: Capture,
  store?: Store,
  logger?: RequestLogger,
): void {
  const rawUrl = req.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart);

  if (handleControl(req, res, pathname, registry, state, capture)) return;
  if (handleUi(req, res, pathname)) return;
  if (store && handleApi(req, res, pathname, store)) return;

  const route = parseRoute(pathname, providers, state.activeBedrockSession);
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

  const extraHeaders: Record<string, string> = {};
  if (route.sessionId) {
    const session = registry.get(route.sessionId);
    if (session?.meta?.armada_node) {
      extraHeaders["x-armada-node"] = session.meta.armada_node;
    }
  }

  // Bedrock requires SigV4 re-signing — the original signature is for the proxy host.
  if (route.provider === "bedrock") {
    const upstreamUrl = new URL(provider.upstream);
    const region = upstreamUrl.hostname.split(".")[1] ?? "us-east-1";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      trace?.finish();
    };
    forwardBedrock(req, res, {
      upstreamHost: upstreamUrl.hostname,
      path: route.upstreamPath + search,
      region,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      onRequestChunk: (chunk) => trace?.requestChunk(chunk),
      onResponse: (status, headers) => trace?.response(status, undefined, headers as Record<string, string>),
      onResponseChunk: (chunk) => trace?.responseChunk(chunk),
      onFinish: finish,
    });
    return;
  }

  forward(req, res, provider.upstream, route.upstreamPath + search, {
    trace,
    logger,
    extraHeaders,
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
  state: ProxyState,
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
      registerSession(req, res, registry, state, capture);
      return true;
    }
  }
  return false;
}

function registerSession(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry,
  state: ProxyState,
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
      meta:
        info.meta && typeof info.meta === "object"
          ? (info.meta as Record<string, string>)
          : null,
    };
    registry.register(session);
    capture?.upsertSession(session);
    if (session.meta?.bedrock === "1") {
      state.activeBedrockSession = session.id;
    }
    sendJson(res, 200, { ok: true });
  });
}

interface ForwardObs {
  trace?: RequestTrace;
  logger?: RequestLogger;
  extraHeaders?: Record<string, string>;
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
  const { trace, logger, extraHeaders, meta } = obs;
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
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }

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
