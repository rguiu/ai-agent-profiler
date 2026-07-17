import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  analyzeIdleGaps,
  commandBreakdown,
  detectRegenerations,
  detectSearchReadChains,
} from "../analyze/index.js";
import { summarizeMessages, type TraceEvent } from "../parse/index.js";
import { recommend } from "../recommend/index.js";
import {
  isChunkKind,
  SNIPPET_START,
  SNIPPET_END,
  type ChunkKind,
  type SearchStore,
} from "../search/index.js";
import type { Store } from "../store/index.js";

export function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  store: Store,
  search?: SearchStore | null,
): boolean {
  if (pathname === "/search" || pathname.startsWith("/search/")) {
    handleSearch(req, res, pathname, search ?? null);
    return true;
  }

  if (pathname === "/sessions") {
    if (requireGet(req, res)) writeJson(res, 200, store.listSessions());
    return true;
  }

  const toolCallsMatch = pathname.match(/^\/sessions\/([^/]+)\/tool-calls$/);
  if (toolCallsMatch) {
    if (!requireGet(req, res)) return true;
    const id = decodeURIComponent(toolCallsMatch[1] ?? "");
    const s = store.resolveSessionId(id);
    if (!s) {
      writeError(res, 404, `session "${id}" not found`);
      return true;
    }
    writeJson(res, 200, store.sessionToolCalls(s));
    return true;
  }

  if (pathname.startsWith("/sessions/")) {
    if (req.method === "DELETE") {
      const id = extractId(pathname, "/sessions/");
      if (!id) {
        writeError(res, 404, "session id required");
        return true;
      }
      const s = store.resolveSessionId(id);
      if (!s) {
        writeError(res, 404, `session "${id}" not found`);
        return true;
      }
      const detail = store.getSession(s);
      for (const r of detail?.requests ?? []) {
        const reqDetail = store.getRequest(r.id);
        if (reqDetail?.trace_file) {
          try {
            rmSync(reqDetail.trace_file, { force: true });
          } catch {
            /* trace file may already be gone */
          }
        }
      }
      store.deleteSession(s);
      search?.deleteSession(s);
      writeJson(res, 200, { deleted: true });
      return true;
    }
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
    const regenMap = detectRegenerations(
      detail.requests.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        inputTokens: r.input_tokens,
        cachedInputTokens: r.cached_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
        outputTokens: r.output_tokens,
      })),
    );
    const regenerations = Object.fromEntries(regenMap);
    const chainCalls = store.sessionToolCalls(id);
    const chains = detectSearchReadChains(chainCalls);
    writeJson(res, 200, {
      ...detail,
      recommendations: recommend(detail, chains),
      regenerations,
      searchReadChains: chains,
    });
    return true;
  }

  const messagesMatch = pathname.match(/^\/requests\/([^/]+)\/messages$/);
  if (messagesMatch) {
    if (!requireGet(req, res)) return true;
    const id = decodeURIComponent(messagesMatch[1] ?? "");
    const detail = store.getRequest(id);
    if (!detail) {
      writeError(res, 404, `request "${id}" not found`);
      return true;
    }
    if (!detail.trace_file) {
      writeError(res, 404, `request "${id}" has no trace`);
      return true;
    }
    const events = readEvents(detail.trace_file) as TraceEvent[];
    writeJson(res, 200, summarizeMessages(events));
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

  if (pathname === "/kinds") {
    if (requireGet(req, res)) writeJson(res, 200, store.kindBreakdown());
    return true;
  }

  if (pathname === "/tools") {
    if (requireGet(req, res)) writeJson(res, 200, store.globalToolUsage());
    return true;
  }

  if (pathname === "/commands") {
    if (!requireGet(req, res)) return true;
    const url = new URL(req.url ?? "/", "http://localhost");
    const prefix = url.searchParams.get("session");
    let sessionId: string | undefined;
    if (prefix) {
      sessionId = store.resolveSessionId(prefix);
      if (!sessionId) {
        writeError(res, 404, `session "${prefix}" not found`);
        return true;
      }
    }
    writeJson(res, 200, commandBreakdown(store.bashToolCalls(sessionId)));
    return true;
  }

  if (pathname === "/stats/idle-gaps") {
    if (!requireGet(req, res)) return true;
    writeJson(res, 200, analyzeIdleGaps(store.requestTimestamps()));
    return true;
  }

  if (pathname === "/introspections") {
    if (!requireGet(req, res)) return true;
    writeJson(res, 200, listIntrospections());
    return true;
  }

  const introMatch = pathname.match(/^\/introspections\/([^/]+)$/);
  if (introMatch) {
    const id = decodeURIComponent(introMatch[1] ?? "");
    if (req.method === "DELETE") {
      deleteIntrospection(id);
      writeJson(res, 200, { deleted: true });
      return true;
    }
    if (!requireGet(req, res)) return true;
    const report = readIntrospectionReport(id);
    if (!report) {
      writeError(res, 404, `introspection "${id}" not found`);
      return true;
    }
    writeJson(res, 200, report);
    return true;
  }

  return false;
}

function requireGet(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "GET") return true;
  writeError(res, 405, `method ${req.method ?? "?"} not allowed`);
  return false;
}

// GET /search?q=&kind=&session=&tool=&file=&repo=&model=&errors=1&limit=&offset=
// GET /search/status
// GET /search/chunks/{uid}  (full text of one indexed chunk)
function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  search: SearchStore | null,
): void {
  if (!requireGet(req, res)) return;
  if (!search) {
    writeError(res, 503, "search index disabled ([search] enabled = false)");
    return;
  }

  if (pathname === "/search/status") {
    writeJson(res, 200, search.status());
    return;
  }

  const chunkMatch = pathname.match(/^\/search\/chunks\/(.+)$/);
  if (chunkMatch) {
    const uid = decodeURIComponent(chunkMatch[1] ?? "");
    const chunk = search.getChunk(uid);
    if (!chunk) {
      writeError(res, 404, `chunk "${uid}" not found`);
      return;
    }
    writeJson(res, 200, chunk);
    return;
  }

  if (pathname !== "/search") {
    writeError(res, 404, "not found");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams.get("q") ?? "";
  const kindParam = url.searchParams.get("kind");
  let kinds: ChunkKind[] | undefined;
  if (kindParam) {
    const parsed = kindParam.split(",").filter(isChunkKind);
    if (parsed.length === 0) {
      writeError(res, 400, `invalid kind "${kindParam}"`);
      return;
    }
    kinds = parsed;
  }
  const limit = intParam(url, "limit");
  const offset = intParam(url, "offset");
  if (limit === false || offset === false) {
    writeError(res, 400, "limit/offset must be non-negative integers");
    return;
  }

  const hits = search.search({
    query: q,
    session: url.searchParams.get("session") ?? undefined,
    kinds,
    tool: url.searchParams.get("tool") ?? undefined,
    file: url.searchParams.get("file") ?? undefined,
    repo: url.searchParams.get("repo") ?? undefined,
    model: url.searchParams.get("model") ?? undefined,
    errorsOnly: url.searchParams.get("errors") === "1",
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
    limit,
    offset,
  });
  writeJson(res, 200, {
    query: q,
    markers: { start: SNIPPET_START, end: SNIPPET_END },
    hits,
  });
}

// undefined = absent, false = invalid, number = parsed value.
function intParam(url: URL, name: string): number | undefined | false {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return false;
  return value;
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

function introspectionsDir(): string {
  return join(homedir(), ".aap", "introspections");
}

interface IntrospectionEntry {
  id: string;
  created: string;
  hasReport: boolean;
  report?: unknown;
}

function listIntrospections(): IntrospectionEntry[] {
  const dir = introspectionsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() && name !== "CLAUDE.md";
      })
      .sort()
      .reverse()
      .map((name) => {
        const reportPath = join(dir, name, "report.json");
        const hasReport = existsSync(reportPath);
        const created = name.replace(/-/g, ":").replace("T", " ").slice(0, 19);
        let report: unknown;
        if (hasReport) {
          try {
            report = JSON.parse(readFileSync(reportPath, "utf8"));
          } catch {
            /* ignore parse errors */
          }
        }
        return { id: name, created, hasReport, report };
      });
  } catch {
    return [];
  }
}

function readIntrospectionReport(id: string): unknown | null {
  const path = join(introspectionsDir(), id, "report.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function deleteIntrospection(id: string): void {
  try {
    rmSync(join(introspectionsDir(), id), { recursive: true, force: true });
  } catch {
    /* may not exist */
  }
}
