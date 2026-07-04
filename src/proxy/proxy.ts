import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { Config } from "../config/index.js";
import { SessionRegistry, type SessionInfo } from "../session/index.js";
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
): http.Server {
  const providers = new Set(Object.keys(config.providers));
  return http.createServer((req, res) => {
    handle(req, res, config, providers, registry);
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  providers: ReadonlySet<string>,
  registry: SessionRegistry,
): void {
  const rawUrl = req.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const pathname = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const search = queryStart === -1 ? "" : rawUrl.slice(queryStart);

  if (handleControl(req, res, pathname, registry)) return;

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

  forward(req, res, provider.upstream, route.upstreamPath + search);
}

function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  registry: SessionRegistry,
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
      registerSession(req, res, registry);
      return true;
    }
  }
  return false;
}

function registerSession(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry,
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
    registry.register({
      id: info.id,
      client: info.client,
      cwd: info.cwd,
      repo: info.repo ?? null,
      startedAt: info.startedAt ?? new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true });
  });
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  pathWithQuery: string,
): void {
  let base: URL;
  try {
    base = new URL(upstream);
  } catch {
    sendError(res, 500, `Invalid upstream URL "${upstream}"`);
    return;
  }

  const isHttps = base.protocol === "https:";
  const basePath = base.pathname.replace(/\/+$/, "");
  const fullPath = basePath + pathWithQuery;

  const headers: OutgoingHttpHeaders = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  headers["host"] = base.host;

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
      const outHeaders: OutgoingHttpHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP) delete outHeaders[name];
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        outHeaders,
      );
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      sendError(res, 502, `Upstream request failed: ${err.message}`);
    } else {
      res.destroy();
    }
  });

  res.on("close", () => {
    if (!res.writableFinished) upstreamReq.destroy();
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
