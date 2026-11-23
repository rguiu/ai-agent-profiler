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
import {
  clientFromHeaders,
  sessionAliasFromHeaders,
  sessionIdFromHeaders,
} from "./attribution.js";
import { LruMap } from "./lru.js";
import { InflightTracker, type InflightHandle } from "./inflight.js";
import { parseRoute, isOllamaControlPath } from "./route.js";
import { needsShaping, shapeRequestBody } from "./shape.js";
import {
  Throttle,
  ThrottleAbortedError,
  type ThrottleStats,
} from "./throttle.js";

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

/** Last request body per session, kept only for the [cache] hit diagnostic. */
type PrevBodies = LruMap<string, { body: string; path: string }>;

/** Cap on distinct sessions holding a cached previous body in memory. */
const MAX_PREV_BODIES = 256;

/** Clients that keep their own name for Ollama traffic. Everything else — a
 * plain HTTP client, or an app that declares itself through `x-aap-client` —
 * is recorded as an Ollama session instead of surfacing the app's name. */
const OLLAMA_NAMED_CLIENTS: ReadonlySet<string> = new Set([
  "claude",
  "opencode",
  "pi",
  "stackpilot",
  "ollama-cli",
]);

export interface ProxyState {
  activeBedrockSession: string | null;
  activeOllamaSession: string | null;
}

/** Everything the control plane needs to explain a stuck proxy. */
export interface ProxyDiagnostics {
  inflight: InflightTracker;
  throttleStats: () => Record<string, ThrottleStats>;
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
  // Seed the active Bedrock session from persisted state (most-recent first) so
  // single-session routing survives a restart even though the in-memory registry
  // starts empty (no hydration). Ollama is deliberately not seeded: its pin is
  // only a fallback for `aap run` when the OS won't resolve the session alias,
  // and resurrecting one after a restart would make a launcher-less
  // `ollama launch` join a dead session instead of its own bucket.
  let initialBedrock: string | null = null;
  for (const s of store?.recentSessions() ?? []) {
    const meta = s.meta ? (JSON.parse(s.meta) as Record<string, string>) : null;
    if (
      initialBedrock === null &&
      providers.has("bedrock") &&
      meta?.bedrock === "1"
    )
      initialBedrock = s.id;
    if (initialBedrock !== null) break;
  }
  const state: ProxyState = {
    activeBedrockSession: initialBedrock,
    activeOllamaSession: null,
  };

  // One throttle per provider: a slow or wedged upstream (a long Anthropic
  // stream, a stuck Bedrock socket) must not consume the slots that the other
  // providers' agents need. Created lazily so newly configured providers get
  // one without restarting.
  const throttles = new Map<string, Throttle>();
  const throttleFor = (provider: string): Throttle => {
    let throttle = throttles.get(provider);
    if (!throttle) {
      throttle = new Throttle(config.throttle);
      throttles.set(provider, throttle);
    }
    return throttle;
  };
  // Bounded so long-lived/idle sessions can't accumulate full request bodies
  // in memory. Only feeds the [cache] diagnostic, so eviction is harmless.
  const prevBodies: PrevBodies = new LruMap(MAX_PREV_BODIES);
  // Live table of what the proxy is currently holding and where it is stuck, so
  // a wedged serve can be diagnosed over HTTP instead of by restart.
  const inflight = new InflightTracker();
  const diagnostics: ProxyDiagnostics = {
    inflight,
    // Report every configured provider, not just the ones that have served
    // traffic yet, so /health shows the cap you are comparing against.
    throttleStats: (): Record<string, ThrottleStats> => {
      const out: Record<string, ThrottleStats> = {};
      for (const provider of providers) {
        out[provider] = throttleFor(provider).stats();
      }
      for (const [provider, throttle] of throttles) {
        if (!out[provider]) out[provider] = throttle.stats();
      }
      return out;
    },
  };

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
      throttleFor,
      prevBodies,
      search,
      diagnostics,
    );
  });
}

/** Rate limiter for the "queueing" warning: one line per 5s is enough to spot a
 * backlog building without flooding the terminal. */
const QUEUE_WARN_INTERVAL_MS = 5_000;
let lastQueueWarnAt = 0;

function warnQueued(pathname: string, stats: ThrottleStats): void {
  const now = Date.now();
  if (now - lastQueueWarnAt < QUEUE_WARN_INTERVAL_MS) return;
  lastQueueWarnAt = now;
  process.stderr.write(
    `[throttle] queueing ${pathname} — inflight=${stats.inflight}/${stats.maxConcurrent} ` +
      `queued=${stats.queued} oldest=${stats.oldestQueuedMs}ms\n`,
  );
}

/** Run a callback at most once: exactly one slot release per acquire, whichever
 * tear-down path gets there first. */
function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
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
  throttleFor: (provider: string) => Throttle = () =>
    new Throttle(config.throttle),
  prevBodies?: PrevBodies,
  searchStore?: SearchStore | null,
  diagnostics?: ProxyDiagnostics,
): void {
  const rawUrl = req.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart);

  if (
    handleControl(
      req,
      res,
      pathname,
      registry,
      state,
      capture,
      prevBodies,
      diagnostics,
    )
  )
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
  const throttle = throttleFor(route.provider);

  const method = req.method ?? "GET";
  const isKeepAlive = req.headers["x-aap-keep-alive"] === "1";

  // Transparent attribution: an explicit session id (path pin or launcher
  // alias) wins, then the id the client advertises itself, then the single
  // active Bedrock/Ollama pin. That is what lets a client reach the proxy with
  // a constant base URL and no launcher — see `aap route`.
  const isOllama =
    route.provider === "ollama" || route.provider === "ollama-cloud";
  const detectedClient = clientFromHeaders(req.headers, {
    includeExplicit: !isOllama,
  });
  // Direct `/v1` and `/api` clients are recorded as Ollama sessions. A client
  // that names itself through `x-aap-client` cannot turn its app name into an
  // AAP session; known agents keep their own label so `ollama launch
  // opencode/pi/claude` still looks like that agent.
  const client =
    isOllama && (!detectedClient || !OLLAMA_NAMED_CLIENTS.has(detectedClient))
      ? "ollama"
      : detectedClient;
  const headerSessionId = sessionIdFromHeaders(req.headers, {
    includeExplicit: !isOllama,
  });
  // A launcher-started ollama agent dials `<session>.localhost`; that name is
  // the session id OLLAMA_HOST cannot carry in a path. It beats the pin, so a
  // second launch never merges into whichever session `aap run` started earlier.
  const aliasSessionId = isOllama
    ? (registry.byOllamaAlias(sessionAliasFromHeaders(req.headers) ?? "")?.id ??
      null)
    : null;
  // route.sessionId is either an explicit path pin (benchmarking, `aap run`) or
  // one of the single-slot pins (Bedrock, Ollama). A pin is only a fallback: an
  // agent that advertises its own id (opencode's x-opencode-session) has finer
  // granularity, so preferring the header stops concurrent launcher-less
  // launches from collapsing into one pinned session. Bedrock keeps the pin
  // ahead of the header so `aap run claude` on Bedrock keeps its launcher id.
  const isExplicitPathPin =
    route.sessionId !== null && pathname.startsWith(`/${route.sessionId}/`);
  const explicitSessionId = isExplicitPathPin ? route.sessionId : null;
  const pinSessionId = isExplicitPathPin ? null : route.sessionId;
  const clientSessionId = isOllama ? headerSessionId : null;
  const sessionId =
    explicitSessionId ??
    aliasSessionId ??
    clientSessionId ??
    pinSessionId ??
    headerSessionId ??
    null;

  // A header-attributed session has no registration, so seed the registry with
  // what we know. Without this, per-session meta (armada_node, cache_ttl) and
  // `/_control/sessions` would miss every launcher-less session.
  if (
    sessionId &&
    sessionId !== route.sessionId &&
    store &&
    !registry.get(sessionId)
  ) {
    registry.register({
      id: sessionId,
      client: client ?? undefined,
      startedAt: new Date().toISOString(),
    });
  }

  const requestId = randomUUID();
  let trace: RequestTrace | undefined;
  // Control-plane calls (model list, health/account probes, model management)
  // are forwarded but not traced: they have no prompt or response to profile.
  // Match the upstream path, not the incoming one — `aap route` prefixes it
  // with the provider (/ollama/api/tags), which would otherwise look like
  // inference and create an empty unattributed session on every opencode launch.
  const isControlCall =
    route.provider === "ollama" && isOllamaControlPath(route.upstreamPath);
  if (capture && !isControlCall) {
    trace = capture.begin({
      sessionId:
        sessionId ?? capture.nextUnattributedSession(Date.now(), client),
      requestId,
      provider: route.provider,
      method,
      path: pathname + search,
      httpVersion: req.httpVersion,
      headers: req.headers,
      startedAt: Date.now(),
      keepAlive: isKeepAlive || undefined,
      client,
    });
  }

  // Live diagnostics entry, created as soon as the request is accepted. A
  // request held behind a busy provider is then visible (with its wait time)
  // instead of looking like a call that was captured but never forwarded.
  const tracking = diagnostics?.inflight.begin({
    id: requestId,
    sessionId: sessionId ?? null,
    provider: route.provider,
    method,
    path: pathname + search,
    upstream: provider.upstream,
    client: client ?? null,
  });

  const extraHeaders: Record<string, string> = {};
  let cacheTtlUpgrade = false;
  if (sessionId) {
    const session = registry.get(sessionId);
    if (session?.meta?.armada_node) {
      extraHeaders["x-armada-node"] = session.meta.armada_node;
    }
    if (session?.meta?.cache_ttl === "1h") {
      cacheTtlUpgrade = true;
    }
  }

  // Exactly one slot release per acquire, whichever teardown path fires first.
  const releaseSlot = once(() => throttle.release());

  const doForward = (): void => {
    tracking?.started();
    tracking?.phase("connecting");
    // Bedrock requires SigV4 re-signing — the original signature is for the proxy host.
    if (route.provider === "bedrock") {
      const upstreamUrl = new URL(provider.upstream);
      const region = upstreamUrl.hostname.split(".")[1] ?? "us-east-1";
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        releaseSlot();
        trace?.finish();
        tracking?.end();
      };
      forwardBedrock(req, res, {
        upstreamHost: upstreamUrl.hostname,
        path: route.upstreamPath + search,
        region,
        extraHeaders:
          Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        onRequestChunk: (chunk) => trace?.requestChunk(chunk),
        onResponse: (status, headers) => {
          tracking?.phase("upstream");
          trace?.response(status, undefined, headers as Record<string, string>);
        },
        onResponseChunk: (chunk) => trace?.responseChunk(chunk),
        onFinish: finish,
      });
      return;
    }

    forward(req, res, provider.upstream, route.upstreamPath + search, {
      trace,
      logger,
      extraHeaders,
      release: releaseSlot,
      tracking,
      sessionId,
      prevBodies,
      cacheTtlUpgrade,
      connectTimeoutMs: config.server.connectTimeoutMs,
      timeoutMs: config.server.upstreamTimeoutMs,
      meta: {
        sessionId,
        provider: route.provider,
        method,
        path: route.upstreamPath,
      },
    });
  };

  const before = throttle.stats();
  if (before.inflight >= before.maxConcurrent || before.queued > 0) {
    warnQueued(pathname, before);
  }

  // A client that gives up while still queued must drop its place immediately:
  // otherwise the entry (and its unfinished trace) sits there until the queue
  // timeout, which is far longer than any client's patience.
  const abort = new AbortController();
  const onClientGone = (): void => abort.abort();
  res.once("close", onClientGone);
  req.once("aborted", onClientGone);

  throttle.acquire(abort.signal).then(
    () => {
      res.removeListener("close", onClientGone);
      req.removeListener("aborted", onClientGone);
      // Backstop: forward() releases too, but it cannot if it throws before
      // wiring its own teardown.
      res.once("close", releaseSlot);
      doForward();
    },
    (err: Error) => {
      res.removeListener("close", onClientGone);
      req.removeListener("aborted", onClientGone);
      tracking?.end();
      if (err instanceof ThrottleAbortedError) {
        trace?.error("throttle", "client disconnected while queued");
        trace?.finish();
        return;
      }
      const stats = throttle.stats();
      const detail = `${err.message} (inflight=${stats.inflight}/${stats.maxConcurrent} queued=${stats.queued})`;
      sendError(res, 503, detail);
      trace?.error("throttle", detail);
      trace?.finish();
    },
  );
}

function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  registry: SessionRegistry,
  state: ProxyState,
  capture?: Capture,
  prevBodies?: PrevBodies,
  diagnostics?: ProxyDiagnostics,
): boolean {
  if (pathname === "/health") {
    // Kept backward compatible (`status`) but now says whether the proxy is
    // holding anything: inflight === capacity with requests queued behind it is
    // exactly the "it accepted my request but never called the model" state.
    const stats = diagnostics?.throttleStats() ?? {};
    const inflight = Object.values(stats).reduce(
      (sum, s) => sum + s.inflight,
      0,
    );
    const queued = Object.values(stats).reduce((sum, s) => sum + s.queued, 0);
    sendJson(res, 200, {
      status: "ok",
      uptimeMs: Math.round(process.uptime() * 1000),
      inflight,
      queued,
      oldestQueuedMs: Math.max(
        0,
        ...Object.values(stats).map((s) => s.oldestQueuedMs),
      ),
      providers: stats,
    });
    return true;
  }
  // Everything currently held, oldest first, with the phase it is in. Use this
  // when agents say a call is hanging: "queued" means the provider's slots are
  // busy, "connecting" means the upstream handshake has not completed,
  // "upstream" means we are streaming a response back.
  if (pathname === "/_control/inflight" && req.method === "GET") {
    sendJson(res, 200, {
      now: new Date().toISOString(),
      throttle: diagnostics?.throttleStats() ?? {},
      requests: diagnostics?.inflight.snapshot() ?? [],
    });
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
  /** Idempotent: called exactly once when the request leaves the proxy. */
  release?: () => void;
  tracking?: InflightHandle;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  sessionId?: string | null;
  prevBodies?: PrevBodies;
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
    release,
    tracking,
    timeoutMs,
    connectTimeoutMs,
    sessionId,
    prevBodies,
    cacheTtlUpgrade,
    meta,
  } = obs;
  const startedAt = Date.now();
  const idleTimeoutMs = timeoutMs ?? 120_000;
  const connectMs = connectTimeoutMs ?? 15_000;
  let status: number | null = null;
  let responseBytes = 0;
  let errorMessage: string | undefined;
  let finished = false;

  const emitFinish = (): void => {
    if (finished) return;
    finished = true;
    clearConnectTimer();
    release?.();
    tracking?.end();
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

  let upstreamReq: http.ClientRequest | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const clearConnectTimer = (): void => {
    if (connectTimer === undefined) return;
    clearTimeout(connectTimer);
    connectTimer = undefined;
  };

  // Teardown is registered before the body is buffered, not after: a client
  // that aborts while still uploading never reaches sendUpstream, and its
  // throttle slot must still be released or the provider slowly loses
  // capacity. emitFinish's `finished` guard makes repeated calls harmless.
  res.on("finish", () => {
    trace?.finish();
    emitFinish();
  });
  res.on("close", () => {
    if (!res.writableFinished) upstreamReq?.destroy();
    trace?.finish();
    emitFinish();
  });
  req.on("error", (err) => {
    errorMessage ??= err.message;
    emitFinish();
  });
  req.on("aborted", () => {
    errorMessage ??= "client aborted";
    emitFinish();
  });

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
    // The client may have gone away while the body was being buffered.
    if (finished) return;
    if (body) {
      headers["content-length"] = body.length.toString();
      trace?.requestChunk(body);
    }
    tracking?.phase("connecting");
    const request = transport.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        method: req.method,
        path: fullPath,
        headers,
        // Anthropic can go quiet for 30s+ with no bytes (not even a ping)
        // during extended thinking; a short socket-inactivity timeout tears
        // down the healthy stream and surfaces as "Connection lost
        // mid-response" on the client. See bedrock.ts's STREAM_IDLE_TIMEOUT_MS
        // for the same issue observed on that path.
        timeout: idleTimeoutMs,
      },
      (upstreamRes) => {
        clearConnectTimer();
        tracking?.phase("upstream");
        status = upstreamRes.statusCode ?? 502;
        const outHeaders: OutgoingHttpHeaders = { ...upstreamRes.headers };
        for (const name of HOP_BY_HOP) delete outHeaders[name];
        trace?.response(status, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          trace?.responseChunk(chunk);
        });
        // Anthropic (and any upstream) can reset mid-stream on a long-running
        // response. With no listener here, Node treats it as an unhandled
        // 'error' event and throws, crashing the whole aap serve process.
        upstreamRes.on("error", (err) => {
          errorMessage = err.message;
          trace?.error("upstream-read", err.message);
          res.destroy();
        });
        try {
          res.writeHead(status, upstreamRes.statusMessage, outHeaders);
        } catch (err) {
          // An upstream header Node refuses to forward must not become an
          // uncaught throw: fail this request, keep serving the others.
          errorMessage = `invalid upstream headers: ${(err as Error).message}`;
          trace?.error("upstream-headers", errorMessage);
          process.stderr.write(`[proxy] ${errorMessage}\n`);
          upstreamRes.destroy();
          res.destroy();
          return;
        }
        // Send the headers before the body: a thinking model can hold the first
        // chunk for a minute, and a client (or its TTFB timeout) would otherwise
        // see nothing at all during that time.
        res.flushHeaders();
        upstreamRes.pipe(res);
      },
    );

    upstreamReq = request;

    // A stalled TCP/TLS handshake is what actually wedges a local proxy: the
    // socket sits in SYN_SENT (or mid-TLS) holding a provider slot, and the
    // request's inactivity timeout may not fire until the OS gives up. Fail it
    // fast and say so, instead of losing a slot for a minute or more.
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      process.stderr.write(
        `[proxy] upstream connect timeout after ${connectMs}ms: ${base.host}${fullPath}\n`,
      );
      tracking?.phase("finishing");
      request.destroy(
        new Error(`upstream connect timeout after ${connectMs}ms`),
      );
    }, connectMs);
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        clearConnectTimer();
        return;
      }
      socket.once(isHttps ? "secureConnect" : "connect", clearConnectTimer);
      socket.once("close", clearConnectTimer);
    });

    // Name the timeout so a wedge is identifiable from the request log: an
    // idle-kill and a real upstream error otherwise look identical.
    request.on("timeout", () => {
      process.stderr.write(
        `[proxy] upstream idle timeout after ${idleTimeoutMs}ms: ${base.host}${fullPath}\n`,
      );
      tracking?.phase("finishing");
      request.destroy(
        new Error(`upstream idle timeout after ${idleTimeoutMs}ms`),
      );
    });
    request.on("error", (err) => {
      clearConnectTimer();
      errorMessage = err.message;
      trace?.error("upstream", err.message);
      if (!res.headersSent) {
        sendError(res, 502, `Upstream request failed: ${err.message}`);
      } else {
        res.destroy();
      }
    });

    if (body) {
      request.end(body);
    } else {
      if (trace) req.on("data", (chunk: Buffer) => trace.requestChunk(chunk));
      req.pipe(request);
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
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}
