import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildDrafts, filePathFromArgs, type ChunkItem } from "../extract.js";
import type { SearchStore } from "../search-store.js";

export interface OpencodeImportSummary {
  sessions: number;
  skippedProxied: number;
  messages: number;
  chunks: number;
}

export interface ProxiedSessionWindow {
  cwd: string | null;
  startedAt: string | null;
  lastSeenAt: string | null;
}

interface OcSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
}

export function defaultOpencodeDbPath(home: string = homedir()): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function msToIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

// A session whose traffic already went through the proxy is skipped: the
// proxy-derived index is richer (exact requests, providers, errors). Match =
// same working directory and overlapping time windows.
export function overlapsProxiedSession(
  session: {
    directory: string | null;
    start: string | null;
    end: string | null;
  },
  proxied: readonly ProxiedSessionWindow[],
): boolean {
  if (!session.directory || !session.start) return false;
  const start = Date.parse(session.start);
  const end = session.end ? Date.parse(session.end) : start;
  for (const p of proxied) {
    if (!p.cwd || p.cwd !== session.directory) continue;
    const pStart = p.startedAt ? Date.parse(p.startedAt) : NaN;
    const pEnd = p.lastSeenAt ? Date.parse(p.lastSeenAt) : pStart;
    if (Number.isNaN(pStart)) continue;
    if (start <= pEnd && end >= pStart) return true;
  }
  return false;
}

function itemsFromParts(
  role: string | null,
  parts: readonly Record<string, unknown>[],
): ChunkItem[] {
  const items: ChunkItem[] = [];
  const textKind = role === "assistant" ? "response" : "prompt";
  for (const part of parts) {
    const type = part.type;
    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      items.push({
        kind: textKind,
        role,
        toolName: null,
        filePath: null,
        isError: false,
        text,
      });
    } else if (type === "reasoning") {
      const text = typeof part.text === "string" ? part.text : "";
      items.push({
        kind: "response",
        role: "assistant",
        toolName: null,
        filePath: null,
        isError: false,
        text,
      });
    } else if (type === "tool") {
      const tool = typeof part.tool === "string" ? part.tool : "unknown";
      const state = asRecord(part.state) ?? {};
      const input = state.input;
      const argsText = input !== undefined ? JSON.stringify(input) : "";
      items.push({
        kind: "tool_call",
        role: "assistant",
        toolName: tool,
        filePath: filePathFromArgs(input),
        isError: false,
        text: argsText ? `${tool} ${argsText}` : tool,
      });
      const isError = state.status === "error";
      const output =
        typeof state.output === "string"
          ? state.output
          : typeof state.error === "string"
            ? state.error
            : "";
      if (output) {
        items.push({
          kind: "tool_result",
          role: "tool",
          toolName: tool,
          filePath: null,
          isError,
          text: output,
        });
      }
    }
    // step-start / step-finish / file parts carry no searchable text.
  }
  return items;
}

// Import opencode's local session DB (readonly). Each message becomes a
// synthetic request keyed oc:<message-id>; the session title is indexed as a
// dedicated `title` chunk. Idempotent via index_state, like everything else.
export function importOpencode(
  search: SearchStore,
  indexed: ReadonlySet<string>,
  opts: {
    dbPath?: string;
    proxiedSessions?: readonly ProxiedSessionWindow[];
    includeProxied?: boolean;
  } = {},
): OpencodeImportSummary {
  const dbPath = opts.dbPath ?? defaultOpencodeDbPath();
  const summary: OpencodeImportSummary = {
    sessions: 0,
    skippedProxied: 0,
    messages: 0,
    chunks: 0,
  };
  if (!existsSync(dbPath)) return summary;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const sessions = db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated FROM session`,
      )
      .all() as OcSessionRow[];
    const messagesStmt = db.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY id`,
    );
    const partsStmt = db.prepare(
      `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id`,
    );

    for (const session of sessions) {
      if (
        !opts.includeProxied &&
        overlapsProxiedSession(
          {
            directory: session.directory,
            start: msToIso(session.time_created),
            end: msToIso(session.time_updated),
          },
          opts.proxiedSessions ?? [],
        )
      ) {
        summary.skippedProxied++;
        continue;
      }
      summary.sessions++;

      const baseSource = {
        sessionId: session.id,
        provider: null as string | null,
        model: null as string | null,
        requestKind: null as string | null,
        repo: null,
        cwd: session.directory,
        client: "opencode-import",
      };

      const titleRequestId = `oc:title:${session.id}`;
      if (session.title && !indexed.has(titleRequestId)) {
        summary.chunks += search.indexRequest(
          titleRequestId,
          {
            ...baseSource,
            requestId: titleRequestId,
            ts: msToIso(session.time_created),
          },
          buildDrafts(
            [
              {
                kind: "title",
                role: null,
                toolName: null,
                filePath: null,
                isError: false,
                text: session.title,
              },
            ],
            titleRequestId,
          ),
        );
      }

      const partsByMessage = new Map<string, Record<string, unknown>[]>();
      for (const row of partsStmt.all(session.id) as {
        message_id: string;
        data: unknown;
      }[]) {
        const data = parseJson(row.data);
        if (!data) continue;
        const list = partsByMessage.get(row.message_id) ?? [];
        list.push(data);
        partsByMessage.set(row.message_id, list);
      }

      for (const row of messagesStmt.all(session.id) as {
        id: string;
        time_created: number | null;
        data: unknown;
      }[]) {
        const requestId = `oc:${row.id}`;
        if (indexed.has(requestId)) continue;
        const data = parseJson(row.data) ?? {};
        const role = typeof data.role === "string" ? data.role : null;
        const model = asRecord(data.model);
        const items = itemsFromParts(role, partsByMessage.get(row.id) ?? []);
        if (items.length === 0) continue;

        summary.chunks += search.indexRequest(
          requestId,
          {
            ...baseSource,
            requestId,
            ts: msToIso(row.time_created),
            provider:
              model && typeof model.providerID === "string"
                ? model.providerID
                : null,
            model:
              model && typeof model.modelID === "string" ? model.modelID : null,
          },
          buildDrafts(items, requestId),
        );
        summary.messages++;
      }
    }
  } finally {
    db.close();
  }
  return summary;
}
