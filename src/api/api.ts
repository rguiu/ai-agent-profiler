import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store/index.js";

export function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  store: Store,
): boolean {
  if (pathname === "/sessions") {
    if (requireGet(req, res)) writeJson(res, 200, store.listSessions());
    return true;
  }

  if (pathname.startsWith("/sessions/")) {
    if (!requireGet(req, res)) return true;
    const id = extractId(pathname, "/sessions/");
    if (!id) {
      writeError(res, 404, "session id required");
      return true;
    }
    const detail = store.getSession(id);
    if (!detail) {
      writeError(res, 404, `session "${id}" not found`);
      return true;
    }
    writeJson(res, 200, detail);
    return true;
  }

  if (pathname.startsWith("/requests/")) {
    if (!requireGet(req, res)) return true;
    const id = extractId(pathname, "/requests/");
    if (!id) {
      writeError(res, 404, "request id required");
      return true;
    }
    const detail = store.getRequest(id);
    if (!detail) {
      writeError(res, 404, `request "${id}" not found`);
      return true;
    }
    if (wantsEvents(req) && detail.trace_file) {
      detail.events = readEvents(detail.trace_file);
    }
    writeJson(res, 200, detail);
    return true;
  }

  if (pathname === "/stats") {
    if (requireGet(req, res)) writeJson(res, 200, store.stats());
    return true;
  }

  if (pathname === "/tools") {
    if (requireGet(req, res)) writeJson(res, 200, store.globalToolUsage());
    return true;
  }

  return false;
}

function requireGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET") return true;
  writeError(res, 405, `method ${req.method ?? "?"} not allowed`);
  return false;
}

function extractId(pathname: string, prefix: string): string | null {
  const rest = decodeURIComponent(pathname.slice(prefix.length));
  if (rest.length === 0 || rest.includes("/")) return null;
  return rest;
}

function wantsEvents(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("events") === "1";
}

function readEvents(traceFile: string): unknown[] {
  try {
    const content = readFileSync(traceFile, "utf8");
    const events: unknown[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) events.push(JSON.parse(trimmed));
    }
    return events;
  } catch {
    return [];
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  writeJson(res, status, { error: message });
}
