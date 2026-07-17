import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SEARCH_DROP, SEARCH_SCHEMA, SEARCH_SCHEMA_VERSION } from "./schema.js";
import type { ChunkDraft, ChunkKind, ChunkSource } from "./extract.js";

// Markers emitted by snippet(); consumers replace them with their own
// highlight syntax (the web UI turns them into <mark> after HTML-escaping).
export const SNIPPET_START = "\u0001";
export const SNIPPET_END = "\u0002";

export interface SearchParams {
  query: string;
  session?: string;
  kinds?: ChunkKind[];
  tool?: string;
  file?: string;
  repo?: string;
  model?: string;
  provider?: string;
  // Matches repo OR cwd — what the dashboard calls a "project".
  project?: string;
  errorsOnly?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  chunk_uid: string;
  session_id: string;
  request_id: string;
  ts: string | null;
  kind: ChunkKind;
  role: string | null;
  tool_name: string | null;
  file_path: string | null;
  model: string | null;
  provider: string | null;
  request_kind: string | null;
  repo: string | null;
  cwd: string | null;
  is_error: number;
  snippet: string;
  score: number;
}

export interface SearchPage {
  hits: SearchHit[];
  total: number;
  limit: number;
  offset: number;
}

// Distinct filterable values currently present in the index, for populating
// UI dropdowns. "project" is repo when known, else cwd.
export interface SearchFacets {
  providers: string[];
  projects: string[];
  tools: string[];
  models: string[];
}

export interface ChunkRow extends Omit<SearchHit, "snippet" | "score"> {
  client: string | null;
  text: string;
}

export interface SearchStatus {
  indexedRequests: number;
  failedRequests: number;
  chunks: number;
  lastIndexedAt: string | null;
}

const KINDS: readonly string[] = [
  "prompt",
  "response",
  "tool_call",
  "tool_result",
  "error",
];

export function isChunkKind(value: string): value is ChunkKind {
  return KINDS.includes(value);
}

const MAX_LIMIT = 200;

// Convert free-form user input into a safe FTS5 MATCH expression: quoted
// phrases are preserved, every other token is double-quoted (so FTS operators
// and punctuation can't cause syntax errors), and a trailing * keeps prefix
// semantics. All terms are implicitly ANDed.
export function toFtsQuery(input: string): string {
  const terms: string[] = [];
  for (const match of input.matchAll(/"([^"]*)"|(\S+)/g)) {
    const phrase = match[1];
    const word = match[2];
    if (phrase !== undefined) {
      if (phrase.trim()) terms.push(`"${phrase.replace(/"/g, '""')}"`);
      continue;
    }
    if (word === undefined) continue;
    const prefix = word.endsWith("*") && word.length > 1;
    const bare = prefix ? word.slice(0, -1) : word;
    if (!bare) continue;
    terms.push(`"${bare.replace(/"/g, '""')}"${prefix ? "*" : ""}`);
  }
  return terms.join(" ");
}

export class SearchStore {
  private readonly insertChunkStmt;
  private readonly deleteChunksForRequestStmt;
  private readonly upsertStateStmt;
  private readonly indexedIdsStmt;
  private readonly statusStmt;
  private readonly getChunkStmt;
  private readonly deleteSessionStateStmt;
  private readonly deleteSessionChunksStmt;
  private readonly indexRequestTxn: (
    requestId: string,
    source: ChunkSource,
    drafts: readonly ChunkDraft[],
  ) => number;
  private readonly deleteSessionTxn: (sessionId: string) => void;

  constructor(private readonly db: Database.Database) {
    this.insertChunkStmt = db.prepare(`
      INSERT OR IGNORE INTO chunks
        (chunk_uid, session_id, request_id, ts, kind, role, tool_name,
         file_path, model, provider, request_kind, repo, cwd, client,
         is_error, content_hash, text)
      VALUES
        (@chunk_uid, @session_id, @request_id, @ts, @kind, @role, @tool_name,
         @file_path, @model, @provider, @request_kind, @repo, @cwd, @client,
         @is_error, @content_hash, @text)
    `);
    this.deleteChunksForRequestStmt = db.prepare(
      `DELETE FROM chunks WHERE request_id = ?`,
    );
    this.upsertStateStmt = db.prepare(`
      INSERT INTO index_state (request_id, indexed_at, chunk_count, status, error)
      VALUES (@request_id, @indexed_at, @chunk_count, @status, @error)
      ON CONFLICT(request_id) DO UPDATE SET
        indexed_at  = excluded.indexed_at,
        chunk_count = excluded.chunk_count,
        status      = excluded.status,
        error       = excluded.error
    `);
    this.indexedIdsStmt = db.prepare(`SELECT request_id FROM index_state`);
    this.statusStmt = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM index_state WHERE status = 'ok')    AS indexedRequests,
        (SELECT COUNT(*) FROM index_state WHERE status = 'error') AS failedRequests,
        (SELECT COUNT(*) FROM chunks)                             AS chunks,
        (SELECT MAX(indexed_at) FROM index_state)                 AS lastIndexedAt
    `);
    this.getChunkStmt = db.prepare(`SELECT * FROM chunks WHERE chunk_uid = ?`);
    this.deleteSessionStateStmt = db.prepare(`
      DELETE FROM index_state WHERE request_id IN
        (SELECT DISTINCT request_id FROM chunks WHERE session_id = ?)
    `);
    this.deleteSessionChunksStmt = db.prepare(
      `DELETE FROM chunks WHERE session_id = ?`,
    );

    this.indexRequestTxn = db.transaction(
      (
        requestId: string,
        source: ChunkSource,
        drafts: readonly ChunkDraft[],
      ) => {
        this.deleteChunksForRequestStmt.run(requestId);
        let inserted = 0;
        for (const draft of drafts) {
          const info = this.insertChunkStmt.run({
            chunk_uid: draft.chunkUid,
            session_id: source.sessionId,
            request_id: requestId,
            ts: source.ts,
            kind: draft.kind,
            role: draft.role,
            tool_name: draft.toolName,
            file_path: draft.filePath,
            model: source.model,
            provider: source.provider,
            request_kind: source.requestKind,
            repo: source.repo,
            cwd: source.cwd,
            client: source.client,
            is_error: draft.isError ? 1 : 0,
            content_hash: draft.contentHash,
            text: draft.text,
          });
          inserted += info.changes;
        }
        this.upsertStateStmt.run({
          request_id: requestId,
          indexed_at: new Date().toISOString(),
          chunk_count: inserted,
          status: "ok",
          error: null,
        });
        return inserted;
      },
    );

    this.deleteSessionTxn = db.transaction((sessionId: string) => {
      this.deleteSessionStateStmt.run(sessionId);
      this.deleteSessionChunksStmt.run(sessionId);
    });
  }

  // Idempotent: replaces any prior chunks for the request, dedupes repeated
  // conversation history via the (session_id, content_hash) unique index.
  indexRequest(
    requestId: string,
    source: ChunkSource,
    drafts: readonly ChunkDraft[],
  ): number {
    return this.indexRequestTxn(requestId, source, drafts);
  }

  markFailed(requestId: string, error: string): void {
    this.upsertStateStmt.run({
      request_id: requestId,
      indexed_at: new Date().toISOString(),
      chunk_count: 0,
      status: "error",
      error,
    });
  }

  indexedRequestIds(): Set<string> {
    const rows = this.indexedIdsStmt.all() as { request_id: string }[];
    return new Set(rows.map((r) => r.request_id));
  }

  status(): SearchStatus {
    return this.statusStmt.get() as SearchStatus;
  }

  getChunk(chunkUid: string): ChunkRow | null {
    return (this.getChunkStmt.get(chunkUid) as ChunkRow | undefined) ?? null;
  }

  deleteSession(sessionId: string): void {
    this.deleteSessionTxn(sessionId);
  }

  private buildFilters(params: SearchParams): {
    where: string[];
    args: (string | number)[];
  } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (params.session) {
      where.push("c.session_id = ?");
      args.push(params.session);
    }
    if (params.kinds && params.kinds.length > 0) {
      where.push(`c.kind IN (${params.kinds.map(() => "?").join(", ")})`);
      args.push(...params.kinds);
    }
    if (params.tool) {
      where.push("c.tool_name = ?");
      args.push(params.tool);
    }
    if (params.file) {
      where.push("c.file_path LIKE '%' || ? || '%'");
      args.push(params.file);
    }
    if (params.repo) {
      where.push("c.repo LIKE '%' || ? || '%'");
      args.push(params.repo);
    }
    if (params.model) {
      where.push("c.model LIKE '%' || ? || '%'");
      args.push(params.model);
    }
    if (params.provider) {
      where.push("c.provider = ?");
      args.push(params.provider);
    }
    if (params.project) {
      where.push("(c.repo LIKE '%' || ? || '%' OR c.cwd LIKE '%' || ? || '%')");
      args.push(params.project, params.project);
    }
    if (params.errorsOnly) {
      where.push("(c.is_error = 1 OR c.kind = 'error')");
    }
    if (params.since) {
      where.push("c.ts >= ?");
      args.push(params.since);
    }
    if (params.until) {
      where.push("c.ts <= ?");
      args.push(params.until);
    }
    return { where, args };
  }

  search(params: SearchParams): SearchHit[] {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), MAX_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);
    const { where, args } = this.buildFilters(params);
    const fts = toFtsQuery(params.query);

    if (fts) {
      const clause = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
      const sql = `
        SELECT c.chunk_uid, c.session_id, c.request_id, c.ts, c.kind, c.role,
               c.tool_name, c.file_path, c.model, c.provider, c.request_kind,
               c.repo, c.cwd, c.is_error,
               snippet(chunks_fts, 0, char(1), char(2), ' … ', 24) AS snippet,
               bm25(chunks_fts, 1.0, 3.0, 3.0) AS score
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? ${clause}
        ORDER BY score LIMIT ? OFFSET ?
      `;
      return this.db
        .prepare(sql)
        .all(fts, ...args, limit, offset) as SearchHit[];
    }

    // Browse mode: no text query, filter-only listing (newest first).
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT c.chunk_uid, c.session_id, c.request_id, c.ts, c.kind, c.role,
             c.tool_name, c.file_path, c.model, c.provider, c.request_kind,
             c.repo, c.cwd, c.is_error,
             substr(c.text, 1, 240) AS snippet,
             0.0 AS score
      FROM chunks c
      ${clause}
      ORDER BY c.ts DESC LIMIT ? OFFSET ?
    `;
    return this.db.prepare(sql).all(...args, limit, offset) as SearchHit[];
  }

  count(params: SearchParams): number {
    const { where, args } = this.buildFilters(params);
    const fts = toFtsQuery(params.query);
    if (fts) {
      const clause = where.length > 0 ? `AND ${where.join(" AND ")}` : "";
      const sql = `
        SELECT COUNT(*) AS c
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? ${clause}
      `;
      return (this.db.prepare(sql).get(fts, ...args) as { c: number }).c;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) AS c FROM chunks c ${clause}`;
    return (this.db.prepare(sql).get(...args) as { c: number }).c;
  }

  searchPage(params: SearchParams): SearchPage {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), MAX_LIMIT);
    const offset = Math.max(params.offset ?? 0, 0);
    return {
      hits: this.search(params),
      total: this.count(params),
      limit,
      offset,
    };
  }

  facets(): SearchFacets {
    const values = (sql: string): string[] =>
      (this.db.prepare(sql).all() as { v: string | null }[])
        .map((r) => r.v)
        .filter((v): v is string => v !== null && v !== "");
    return {
      providers: values(
        `SELECT DISTINCT provider AS v FROM chunks ORDER BY provider`,
      ),
      projects: values(
        `SELECT DISTINCT COALESCE(repo, cwd) AS v FROM chunks ORDER BY v`,
      ),
      tools: values(
        `SELECT tool_name AS v FROM chunks WHERE tool_name IS NOT NULL
         GROUP BY tool_name ORDER BY COUNT(*) DESC LIMIT 50`,
      ),
      models: values(`SELECT DISTINCT model AS v FROM chunks ORDER BY model`),
    };
  }

  close(): void {
    this.db.close();
  }
}

export function openSearchStore(dir: string): SearchStore {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "search.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // The index is derived data: on any schema change, drop and let the indexer
  // rebuild from raw traces instead of migrating in place.
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version !== SEARCH_SCHEMA_VERSION) {
    db.exec(SEARCH_DROP);
    db.pragma(`user_version = ${SEARCH_SCHEMA_VERSION}`);
  }
  db.exec(SEARCH_SCHEMA);
  return new SearchStore(db);
}
