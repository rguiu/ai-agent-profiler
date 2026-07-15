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
  analyzePrefixStability,
  analyzeIdleGaps,
  commandBreakdown,
  detectRegenerations,
  detectSearchReadChains,
  summarizePrefixStability,
  type PrefixInput,
  type PrefixTransition,
} from "../analyze/index.js";
import {
  summarizeMessages,
  messageText,
  type TraceEvent,
} from "../parse/index.js";
import { recommend } from "../recommend/index.js";
import type { PrefixHistoryRow, Store } from "../store/index.js";

// Converts stored prefix rows (SQL-shaped) into the classifier's input shape.
// Shared between the session detail response and `aap export`.
function toPrefixInputs(rows: PrefixHistoryRow[]): PrefixInput[] {
  return rows.map((row) => ({
    requestId: row.request_id,
    systemHash: row.system_hash,
    toolsHash: row.tools_hash,
    messageHashes: row.message_hashes,
    messageCount: row.message_count,
    model: row.model,
  }));
}

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
      writeJson(res, 200, { deleted: true });
      return true;
    }
    if (req.method === "PATCH") {
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
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        let name: string | null;
        try {
          const parsed = JSON.parse(body || "{}") as { name?: unknown };
          name = typeof parsed.name === "string" ? parsed.name : null;
        } catch {
          writeError(res, 400, "invalid JSON body");
          return;
        }
        store.setSessionName(s, name);
        writeJson(res, 200, {
          id: s,
          name: name && name.trim() ? name.trim() : null,
        });
      });
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
    const prefixInputs = toPrefixInputs(store.getSessionPrefixes(id));
    const prefixResults = analyzePrefixStability(prefixInputs);
    const prefixTransitions = new Map<string, PrefixTransition>(
      prefixResults.map((r) => [r.requestId, r.transition]),
    );
    const prefixStability = summarizePrefixStability(prefixResults);

    const regenMap = detectRegenerations(
      detail.requests.map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        inputTokens: r.input_tokens,
        cachedInputTokens: r.cached_input_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
        outputTokens: r.output_tokens,
      })),
      { prefixTransitions },
    );
    const regenerations = Object.fromEntries(regenMap);
    const chainCalls = store.sessionToolCalls(id);
    const chains = detectSearchReadChains(chainCalls);
    writeJson(res, 200, {
      ...detail,
      recommendations: recommend(detail, chains),
      regenerations,
      prefixStability,
      searchReadChains: chains,
    });
    return true;
  }

  // Full text of one message, lazily fetched when the user expands a clipped
  // preview. Matched before the /messages$ endpoint below.
  const msgTextMatch = pathname.match(/^\/requests\/([^/]+)\/messages\/(\d+)$/);
  if (msgTextMatch) {
    if (!requireGet(req, res)) return true;
    const id = decodeURIComponent(msgTextMatch[1] ?? "");
    const index = Number(msgTextMatch[2]);
    const detail = store.getRequest(id);
    if (!detail?.trace_file) {
      writeError(res, 404, `request "${id}" has no trace`);
      return true;
    }
    const events = readEvents(detail.trace_file) as TraceEvent[];
    writeJson(res, 200, { index, text: messageText(events, index) });
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
    const stack = summarizeMessages(events);
    // Attach the previous request's per-message hashes (same session, ordered by
    // started_at) so the UI can flag which messages are new/rewritten vs the
    // prior turn — the key signal for understanding a recap/compaction.
    const prefixes = store.getSessionPrefixes(detail.session_id);
    const pos = prefixes.findIndex((p) => p.request_id === id);
    const previousMessageHashes =
      pos > 0 ? (prefixes[pos - 1]?.message_hashes ?? null) : null;
    writeJson(res, 200, { ...stack, previousMessageHashes });
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
