import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import { commonPrefixTokens, estimateTokens } from "../cache/common-prefix.js";
import type { Capture, RequestTrace } from "../capture/index.js";
import { handleApi } from "../api/index.js";
import { applyCacheTtlUpgrade } from "../cache/ttl-upgrade.js";
import { SessionRegistry, type SessionInfo } from "../session/index.js";
import type { SearchStore } from "../search/index.js";
import type { Store } from "../store/index.js";
import { handleUi } from "../ui/index.js";
import type { RequestLogEntry, RequestLogger } from "./log.js";
import { forwardBedrock } from "./bedrock.js";
import { parseRoute } from "./route.js";
import { needsShaping, shapeRequestBody } from "./shape.js";
import { Throttle } from "./throttle.js";

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
  activeOllamaSession: string | null;
}

export function createProxyServer(
  config: Config,
  registry: SessionRegistry,
  capture?: Capture,
  store?: Store,
  logger?: RequestLogger,
  search?: SearchStore | null,
): http.Server {
  const providers = new Set(Object.keys(config.providers));
  // Initialize active provider sessions from hydrated registry (survives restart)
  let initialBedrock: string | null = null;
  let initialOllama: string | null = null;
  for (const s of registry.list()) {
    if (providers.has("bedrock") && s.meta?.bedrock === "1")
      initialBedrock = s.id;
    if (providers.has("ollama") && s.meta?.ollama === "1") initialOllama = s.id;
  }
  const state: ProxyState = {
    activeBedrockSession: initialBedrock,
    activeOllamaSession: initialOllama,
  };

  const throttle = new Throttle(config.throttle);
  const prevBodies = new Map<string, { body: string; path: string }>();

  return http.createServer((req, res) => {
    handle(
      req,
      res,
      config,
      providers,
      registry,
      state,
      capture,
      store,
      logger,
      throttle,
      prevBodies,
      search,
    );
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
  throttle?: Throttle,
  prevBodies?: Map<string, { body: string; path: string }>,
  searchStore?: SearchStore | null,
): void {
  const rawUrl = req.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart);

  if (handleControl(req, res, pathname, registry, state, capture, prevBodies))
    return;
  if (handleUi(req, res, pathname)) return;
  if (store && handleApi(req, res, pathname, store, searchStore)) return;

  const route = parseRoute(
    pathname,
    providers,
    state.activeBedrockSession,
    state.activeOllamaSession,
  );
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
  const isKeepAlive = req.headers["x-aap-keep-alive"] === "1";

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
      keepAlive: isKeepAlive || undefined,
    });
  }

  const extraHeaders: Record<string, string> = {};
  let cacheTtlUpgrade = false;
  if (route.sessionId) {
    const session = registry.get(route.sessionId);
    if (session?.meta?.armada_node) {
      extraHeaders["x-armada-node"] = session.meta.armada_node;
    }
    if (session?.meta?.cache_ttl === "1h") {
      cacheTtlUpgrade = true;
    }
  }

  const doForward = (): void => {
    // Bedrock requires SigV4 re-signing — the original signature is for the proxy host.
    if (route.provider === "bedrock") {
      const upstreamUrl = new URL(provider.upstream);
      const region = upstreamUrl.hostname.split(".")[1] ?? "us-east-1";
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        throttle?.release();
        trace?.finish();
      };
      forwardBedrock(req, res, {
        upstreamHost: upstreamUrl.hostname,
        path: route.upstreamPath + search,
        region,
        extraHeaders:
          Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        onRequestChunk: (chunk) => trace?.requestChunk(chunk),
        onResponse: (status, headers) =>
          trace?.response(status, undefined, headers as Record<string, string>),
        onResponseChunk: (chunk) => trace?.responseChunk(chunk),
        onFinish: finish,
      });
      return;
    }

    forward(req, res, provider.upstream, route.upstreamPath + search, {
      trace,
      logger,
      extraHeaders,
      throttle,
      timeoutMs: route.provider === "ollama" ? 120_000 : undefined,
      sessionId: route.sessionId,
      prevBodies,
      cacheTtlUpgrade,
      meta: {
        sessionId: route.sessionId,
        provider: route.provider,
        method,
        path: route.upstreamPath,
      },
    });
  };

  if (throttle) {
    throttle.acquire().then(doForward, (err: Error) => {
      sendError(res, 503, err.message);
      trace?.error("throttle", err.message);
      trace?.finish();
    });
  } else {
    doForward();
  }
}

function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  registry: SessionRegistry,
  state: ProxyState,
  capture?: Capture,
  prevBodies?: Map<string, { body: string; path: string }>,
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
  const lastBodyMatch = pathname.match(
    /^\/_control\/sessions\/([^/]+)\/last-body$/,
  );
  if (lastBodyMatch && req.method === "GET") {
    const sid = decodeURIComponent(lastBodyMatch[1] ?? "");
    const entry = prevBodies?.get(sid) ?? null;
    sendJson(res, 200, {
      sessionId: sid,
      body: entry?.body ?? null,
      path: entry?.path ?? null,
    });
    return true;
  }
  return false;
}

const MAX_CONTROL_BODY = 64 * 1024;

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
    if (body.length > MAX_CONTROL_BODY) {
      sendError(res, 413, "request body too large");
      req.destroy();
    }
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
    if (session.meta?.ollama === "1") {
      state.activeOllamaSession = session.id;
    }
    sendJson(res, 200, { ok: true });
  });
}

interface ForwardObs {
  trace?: RequestTrace;
  logger?: RequestLogger;
  extraHeaders?: Record<string, string>;
  throttle?: Throttle;
  timeoutMs?: number;
  sessionId?: string | null;
  prevBodies?: Map<string, { body: string; path: string }>;
  cacheTtlUpgrade?: boolean;
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
  const {
    trace,
    logger,
    extraHeaders,
    throttle,
    timeoutMs,
    sessionId,
    prevBodies,
    cacheTtlUpgrade,
    meta,
  } = obs;
  const startedAt = Date.now();
  let status: number | null = null;
  let responseBytes = 0;
  let errorMessage: string | undefined;
  let finished = false;

  const emitFinish = (): void => {
    if (finished) return;
    finished = true;
    throttle?.release();
    if (logger) {
      logger({
        ...meta,
        status,
        latencyMs: Date.now() - startedAt,
        responseBytes,
        error: errorMessage,
      });
    }
  };

  let base: URL;
  try {
    base = new URL(upstream);
  } catch {
    errorMessage = `Invalid upstream URL "${upstream}"`;
    sendError(res, 500, errorMessage);
    trace?.error("resolve", errorMessage);
    trace?.finish();
    emitFinish();
    return;
  }

  const isHttps = base.protocol === "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  const fullPath = basePath + pathWithQuery;

  const headers: OutgoingHttpHeaders = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  delete headers["x-aap-keep-alive"];
  headers["host"] = base.host;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }

  // Request-body tracing happens in sendUpstream so the trace records the
  // exact bytes sent upstream (post shaping/), not the raw request.
  const transport = isHttps ? https : http;

  const sendUpstream = (body?: Buffer): void => {
    if (body) {
      headers["content-length"] = body.length.toString();
      trace?.requestChunk(body);
    }
    const upstreamReq = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        method: req.method,
        path: fullPath,
        headers,
        timeout: timeoutMs ?? 30_000,
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

    upstreamReq.on("timeout", () => upstreamReq.destroy());
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
      emitFinish();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
      trace?.finish();
      emitFinish();
    });

    if (body) {
      upstreamReq.end(body);
    } else {
      if (trace) req.on("data", (chunk: Buffer) => trace.requestChunk(chunk));
      req.pipe(upstreamReq);
    }
  };

  // Buffer the body when either the request shaper (always-on, for token/cost
  // accuracy) needs to rewrite it. Shaper runs first.
  const willShape = needsShaping(meta.provider, req.method ?? "GET", meta.path);
  if (willShape || cacheTtlUpgrade) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Buffer = Buffer.concat(chunks);
      if (willShape) {
        body = shapeRequestBody(
          body,
          meta.provider,
          req.method ?? "GET",
          meta.path,
        );
      }
      if (cacheTtlUpgrade) {
        try {
          const parsed = JSON.parse(body.toString("utf8")) as Record<
            string,
            unknown
          >;
          if (applyCacheTtlUpgrade(parsed)) {
            body = Buffer.from(JSON.stringify(parsed), "utf8");
          }
        } catch {
          // not JSON — skip TTL upgrade
        }
      }

      if (sessionId && prevBodies) {
        const currentBody = body.toString("utf8");
        const prev = prevBodies.get(sessionId);
        if (prev) {
          const hitTokens = commonPrefixTokens(prev.body, currentBody);
          const totalTokens = estimateTokens(currentBody);
          const missTokens = totalTokens - hitTokens;
          const hitPct =
            totalTokens > 0 ? Math.round((hitTokens / totalTokens) * 100) : 0;
          process.stderr.write(
            `[cache] ${sessionId.slice(0, 8)} hit=${hitPct}% hitT=${hitTokens} missT=${missTokens} totalT=${totalTokens}\n`,
          );
        }
        prevBodies.set(sessionId, { body: currentBody, path: pathWithQuery });
      }

      sendUpstream(body);
    });
  } else {
    sendUpstream();
  }
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
