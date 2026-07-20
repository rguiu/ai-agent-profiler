import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { commandBreakdown, type CommandStat } from "../analyze/index.js";
import type { SessionInfo } from "../session/index.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  client        TEXT,
  cwd           TEXT,
  repo          TEXT,
  started_at    TEXT,
  first_seen_at TEXT,
  last_seen_at  TEXT,
  meta          TEXT,
  title         TEXT,
  summary       TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  method         TEXT,
  path           TEXT,
  trace_file     TEXT,
  started_at     TEXT,
  ended_at       TEXT,
  status         INTEGER,
  latency_ms     INTEGER,
  request_bytes  INTEGER,
  response_bytes INTEGER,
  error          TEXT,
  keep_alive     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_requests_session ON requests (session_id);
CREATE INDEX IF NOT EXISTS idx_requests_started ON requests (started_at);

CREATE TABLE IF NOT EXISTS metrics (
  request_id      TEXT PRIMARY KEY,
  format          TEXT,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  stop_reason     TEXT,
  streaming       INTEGER,
  tool_call_count INTEGER,
  cost            REAL,
  parsed_at       TEXT,
  message_count   INTEGER,
  system_tokens   INTEGER,
  tools_defined   INTEGER,
  tools_tokens    INTEGER,
  cached_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  kind            TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  arguments     TEXT,
  tool_id       TEXT,
  result_bytes  INTEGER,
  result_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls (request_id);


`;

export interface RequestRow {
  id: string;
  sessionId: string;
  provider: string;
  method: string;
  path: string;
  traceFile: string;
  startedAt: string;
  keepAlive?: number;
}

export interface RequestFinish {
  status: number | null;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  endedAt: string;
  error: string | null;
}

export interface ParseTarget {
  id: string;
  trace_file: string;
  session_id: string;
}

// A parsed request ready for search indexing, joined with the session and
// metrics metadata that gets denormalized onto every chunk.
export interface SearchIndexTarget {
  id: string;
  session_id: string;
  trace_file: string;
  started_at: string | null;
  provider: string | null;
  model: string | null;
  request_kind: string | null;
  repo: string | null;
  cwd: string | null;
  client: string | null;
}

export interface MetricsRow {
  requestId: string;
  format: string;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  streaming: number;
  toolCallCount: number;
  cost: number | null;
  parsedAt: string;
  messageCount: number;
  systemTokens: number;
  toolsDefined: number;
  toolsTokens: number;
  kind: string;
}

export interface SessionSummary {
  id: string;
  client: string | null;
  cwd: string | null;
  repo: string | null;
  started_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  request_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cost: number;
  tool_calls: number;
  meta: Record<string, string> | null;
  title: string | null;
  summary: string | null;
}

export interface SessionRow {
  id: string;
  client: string | null;
  cwd: string | null;
  repo: string | null;
  started_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  meta: Record<string, string> | null;
  title: string | null;
  summary: string | null;
}

export interface SessionRequest {
  id: string;
  provider: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latency_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  request_bytes: number | null;
  response_bytes: number | null;
  error: string | null;
  format: string | null;
  model: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  output_tokens: number | null;
  stop_reason: string | null;
  cost: number | null;
  tool_call_count: number | null;
  kind: string | null;
}

export interface SessionDetail {
  session: SessionRow;
  requests: SessionRequest[];
  analysis: SessionAnalysis;
}

export interface ToolCall {
  ordinal: number;
  name: string;
  arguments: string | null;
  tool_id: string | null;
  result_bytes: number | null;
  result_tokens: number | null;
}

export interface ToolCallInput {
  id: string;
  name: string;
  arguments: string;
}

export interface RequestDetail {
  id: string;
  session_id: string;
  provider: string;
  method: string | null;
  path: string | null;
  trace_file: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: number | null;
  latency_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  error: string | null;
  format: string | null;
  model: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  output_tokens: number | null;
  stop_reason: string | null;
  streaming: number | null;
  tool_call_count: number | null;
  cost: number | null;
  parsed_at: string | null;
  message_count: number | null;
  system_tokens: number | null;
  tools_defined: number | null;
  tools_tokens: number | null;
  kind: string | null;
  keep_alive: number | null;
  toolCalls: ToolCall[];
  events?: unknown[];
}

export interface Stats {
  sessions: number;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface KindBreakdown {
  kind: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface ToolUsage {
  name: string;
  count: number;
  result_tokens: number;
}

export interface RepeatedToolCall {
  name: string;
  arguments: string | null;
  count: number;
}

export interface GrowthPoint {
  id: string;
  started_at: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  output_tokens: number | null;
}

export interface SessionContext {
  requests: number;
  system_tokens_total: number;
  tools_tokens_total: number;
  input_tokens_total: number;
  cached_input_tokens_total: number;
}

export interface SessionToolCall {
  request_id: string;
  started_at: string | null;
  ordinal: number;
  name: string;
  arguments: string | null;
  result_tokens: number | null;
}

export interface SessionAnalysis {
  toolUsage: ToolUsage[];
  repeated: RepeatedToolCall[];
  growth: GrowthPoint[];
  context: SessionContext;
  commands: CommandStat[];
}

export class Store {
  private readonly upsertSessionStmt;
  private readonly insertRequestStmt;
  private readonly finishRequestStmt;
  private readonly allTargetsStmt;
  private readonly pendingTargetsStmt;
  private readonly searchIndexTargetsStmt;
  private readonly upsertMetricsStmt;
  private readonly deleteToolCallsStmt;
  private readonly insertToolCallStmt;
  private readonly recordToolResultStmt;
  private readonly replaceToolCallsTxn: (
    requestId: string,
    calls: readonly ToolCallInput[],
  ) => void;
  private readonly listSessionsStmt;
  private readonly getSessionStmt;
  private readonly getSessionRequestsStmt;
  private readonly getRequestStmt;
  private readonly getToolCallsStmt;
  private readonly statsStmt;
  private readonly kindBreakdownStmt;
  private readonly toolUsageGlobalStmt;
  private readonly toolUsageSessionStmt;
  private readonly repeatedToolCallsStmt;
  private readonly contextGrowthStmt;
  private readonly sessionContextStmt;
  private readonly sessionToolCallsStmt;
  constructor(private readonly db: Database.Database) {
    this.upsertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, client, cwd, repo, started_at, first_seen_at, last_seen_at, meta)
      VALUES (@id, @client, @cwd, @repo, @started_at, @now, @now, @meta)
      ON CONFLICT(id) DO UPDATE SET
        client       = COALESCE(excluded.client, sessions.client),
        cwd          = COALESCE(excluded.cwd, sessions.cwd),
        repo         = COALESCE(excluded.repo, sessions.repo),
        started_at   = COALESCE(sessions.started_at, excluded.started_at),
        last_seen_at = excluded.last_seen_at,
        meta         = COALESCE(excluded.meta, sessions.meta)
    `);
    this.insertRequestStmt = db.prepare(`
      INSERT INTO requests (id, session_id, provider, method, path, trace_file, started_at, keep_alive)
      VALUES (@id, @session_id, @provider, @method, @path, @trace_file, @started_at, @keep_alive)
    `);
    this.finishRequestStmt = db.prepare(`
      UPDATE requests SET
        status         = @status,
        latency_ms     = @latency_ms,
        request_bytes  = @request_bytes,
        response_bytes = @response_bytes,
        ended_at       = @ended_at,
        error          = @error
      WHERE id = @id
    `);
    this.allTargetsStmt = db.prepare(`
      SELECT id, trace_file, session_id FROM requests WHERE trace_file IS NOT NULL
    `);
    this.pendingTargetsStmt = db.prepare(`
      SELECT r.id, r.trace_file, r.session_id FROM requests r
      LEFT JOIN metrics m ON m.request_id = r.id
      WHERE m.request_id IS NULL
        AND r.trace_file IS NOT NULL
        AND r.ended_at IS NOT NULL
    `);
    // Only parsed requests qualify for search indexing: the metrics JOIN
    // guarantees model/kind are available and the trace was readable.
    // Ordered oldest-first so history dedup attributes content to the request
    // where it first appeared.
    this.searchIndexTargetsStmt = db.prepare(`
      SELECT r.id, r.session_id, r.trace_file, r.started_at, r.provider,
             m.model, m.kind AS request_kind,
             s.repo, s.cwd, s.client
      FROM requests r
      JOIN metrics m ON m.request_id = r.id
      JOIN sessions s ON s.id = r.session_id
      WHERE r.trace_file IS NOT NULL AND r.ended_at IS NOT NULL
      ORDER BY r.started_at ASC
    `);
    this.upsertMetricsStmt = db.prepare(`
      INSERT INTO metrics (request_id, format, model, input_tokens, output_tokens,
                           stop_reason, streaming, tool_call_count, cost, parsed_at,
                           message_count, system_tokens, tools_defined, tools_tokens,
                           cached_input_tokens, cache_creation_input_tokens, kind)
      VALUES (@request_id, @format, @model, @input_tokens, @output_tokens,
              @stop_reason, @streaming, @tool_call_count, @cost, @parsed_at,
              @message_count, @system_tokens, @tools_defined, @tools_tokens,
              @cached_input_tokens, @cache_creation_input_tokens, @kind)
      ON CONFLICT(request_id) DO UPDATE SET
        format          = excluded.format,
        model           = excluded.model,
        input_tokens    = excluded.input_tokens,
        output_tokens   = excluded.output_tokens,
        stop_reason     = excluded.stop_reason,
        streaming       = excluded.streaming,
        tool_call_count = excluded.tool_call_count,
        cost            = excluded.cost,
        parsed_at       = excluded.parsed_at,
        message_count   = excluded.message_count,
        system_tokens   = excluded.system_tokens,
        tools_defined   = excluded.tools_defined,
        tools_tokens    = excluded.tools_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        kind            = excluded.kind
    `);
    this.deleteToolCallsStmt = db.prepare(
      `DELETE FROM tool_calls WHERE request_id = ?`,
    );
    this.insertToolCallStmt = db.prepare(`
      INSERT INTO tool_calls (request_id, ordinal, name, arguments, tool_id)
      VALUES (@request_id, @ordinal, @name, @arguments, @tool_id)
    `);
    this.recordToolResultStmt = db.prepare(`
      UPDATE tool_calls SET result_bytes = @bytes, result_tokens = @tokens
      WHERE tool_id = @tool_id
    `);
    this.replaceToolCallsTxn = db.transaction(
      (requestId: string, calls: readonly ToolCallInput[]) => {
        this.deleteToolCallsStmt.run(requestId);
        calls.forEach((call, ordinal) => {
          this.insertToolCallStmt.run({
            request_id: requestId,
            ordinal,
            name: call.name,
            arguments: call.arguments === "" ? null : call.arguments,
            tool_id: call.id === "" ? null : call.id,
          });
        });
      },
    );
    this.listSessionsStmt = db.prepare(`
      SELECT s.id, s.client, s.cwd, s.repo, s.started_at, s.first_seen_at, s.last_seen_at, s.meta, s.title, s.summary,
             COUNT(r.id) AS request_count,
             COALESCE(SUM(m.input_tokens), 0) + COALESCE(SUM(m.cached_input_tokens), 0) AS input_tokens,
             COALESCE(SUM(m.cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
             COALESCE(SUM(m.cost), 0) AS cost,
             COALESCE(SUM(m.tool_call_count), 0) AS tool_calls
      FROM sessions s
      LEFT JOIN requests r ON r.session_id = s.id
      LEFT JOIN metrics m ON m.request_id = r.id
      GROUP BY s.id
      ORDER BY s.last_seen_at DESC
    `);
    this.getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
    this.getSessionRequestsStmt = db.prepare(`
      SELECT r.id, r.provider, r.method, r.path, r.status, r.latency_ms,
             r.started_at, r.ended_at, r.request_bytes, r.response_bytes, r.error,
             r.keep_alive,
             m.format, m.model, m.input_tokens, m.output_tokens, m.stop_reason,
             m.cost, m.tool_call_count, m.cached_input_tokens,
             m.cache_creation_input_tokens, m.kind
      FROM requests r
      LEFT JOIN metrics m ON m.request_id = r.id
      WHERE r.session_id = ?
      ORDER BY r.started_at
    `);
    this.getRequestStmt = db.prepare(`
      SELECT r.id, r.session_id, r.provider, r.method, r.path, r.trace_file,
             r.started_at, r.ended_at, r.status, r.latency_ms,
             r.request_bytes, r.response_bytes, r.error, r.keep_alive,
             m.format, m.model, m.input_tokens, m.output_tokens, m.stop_reason,
             m.streaming, m.tool_call_count, m.cost, m.parsed_at,
             m.message_count, m.system_tokens, m.tools_defined, m.tools_tokens,
             m.cached_input_tokens, m.cache_creation_input_tokens, m.kind
      FROM requests r
      LEFT JOIN metrics m ON m.request_id = r.id
      WHERE r.id = ?
    `);
    this.getToolCallsStmt = db.prepare(
      `SELECT ordinal, name, arguments, tool_id, result_bytes, result_tokens FROM tool_calls WHERE request_id = ? ORDER BY ordinal`,
    );
    this.statsStmt = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM requests) AS requests,
        COALESCE((SELECT SUM(input_tokens) FROM metrics), 0) + COALESCE((SELECT SUM(cached_input_tokens) FROM metrics), 0) AS input_tokens,
        COALESCE((SELECT SUM(cached_input_tokens) FROM metrics), 0) AS cached_input_tokens,
        COALESCE((SELECT SUM(output_tokens) FROM metrics), 0) AS output_tokens,
        COALESCE((SELECT SUM(cost) FROM metrics), 0) AS cost,
        COALESCE((SELECT SUM(cache_creation_input_tokens) FROM metrics), 0) AS cache_creation_tokens
    `);
    this.kindBreakdownStmt = db.prepare(`
      SELECT COALESCE(kind, 'unknown') AS kind,
             COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cached_input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost), 0) AS cost
      FROM metrics
      GROUP BY COALESCE(kind, 'unknown')
      ORDER BY cost DESC
    `);
    this.toolUsageGlobalStmt = db.prepare(`
      SELECT name, COUNT(*) AS count,
             COALESCE(SUM(result_tokens), 0) AS result_tokens
      FROM tool_calls
      GROUP BY name ORDER BY count DESC, name
    `);
    this.toolUsageSessionStmt = db.prepare(`
      SELECT tc.name, COUNT(*) AS count,
             COALESCE(SUM(tc.result_tokens), 0) AS result_tokens
      FROM tool_calls tc JOIN requests r ON r.id = tc.request_id
      WHERE r.session_id = ?
      GROUP BY tc.name ORDER BY count DESC, tc.name
    `);
    this.repeatedToolCallsStmt = db.prepare(`
      SELECT tc.name, tc.arguments, COUNT(*) AS count
      FROM tool_calls tc JOIN requests r ON r.id = tc.request_id
      WHERE r.session_id = ?
      GROUP BY tc.name, tc.arguments
      HAVING count > 1
      ORDER BY count DESC, tc.name
      LIMIT 50
    `);
    this.contextGrowthStmt = db.prepare(`
      SELECT r.id, r.started_at, m.input_tokens, m.output_tokens,
             m.cached_input_tokens, m.cache_creation_input_tokens
      FROM requests r LEFT JOIN metrics m ON m.request_id = r.id
      WHERE r.session_id = ?
      ORDER BY r.started_at
    `);
    this.sessionContextStmt = db.prepare(`
      SELECT COUNT(m.request_id) AS requests,
             COALESCE(SUM(m.system_tokens), 0) AS system_tokens_total,
             COALESCE(SUM(m.tools_tokens), 0) AS tools_tokens_total,
             COALESCE(SUM(m.input_tokens), 0) AS input_tokens_total,
             COALESCE(SUM(m.cached_input_tokens), 0) AS cached_input_tokens_total
      FROM requests r JOIN metrics m ON m.request_id = r.id
      WHERE r.session_id = ?
    `);
    this.sessionToolCallsStmt = db.prepare(`
      SELECT tc.request_id, tc.ordinal, tc.name, tc.arguments, tc.result_tokens,
             r.started_at
      FROM tool_calls tc
      JOIN requests r ON r.id = tc.request_id
      WHERE r.session_id = ?
      ORDER BY r.started_at, tc.ordinal
    `);
  }

  upsertSession(info: SessionInfo): void {
    this.upsertSessionStmt.run({
      id: info.id,
      client: info.client ?? null,
      cwd: info.cwd ?? null,
      repo: info.repo ?? null,
      started_at: info.startedAt ?? null,
      meta:
        info.meta && Object.keys(info.meta).length > 0
          ? JSON.stringify(info.meta)
          : null,
      now: new Date().toISOString(),
    });
  }

  insertRequest(row: RequestRow): void {
    this.insertRequestStmt.run({
      id: row.id,
      session_id: row.sessionId,
      provider: row.provider,
      method: row.method,
      path: row.path,
      trace_file: row.traceFile,
      started_at: row.startedAt,
      keep_alive: row.keepAlive ?? 0,
    });
  }

  finishRequest(id: string, finish: RequestFinish): void {
    this.finishRequestStmt.run({
      id,
      status: finish.status,
      latency_ms: finish.latencyMs,
      request_bytes: finish.requestBytes,
      response_bytes: finish.responseBytes,
      ended_at: finish.endedAt,
      error: finish.error,
    });
  }

  requestsToParse(all: boolean): ParseTarget[] {
    const stmt = all ? this.allTargetsStmt : this.pendingTargetsStmt;
    return stmt.all() as ParseTarget[];
  }

  searchIndexTargets(): SearchIndexTarget[] {
    return this.searchIndexTargetsStmt.all() as SearchIndexTarget[];
  }

  upsertMetrics(row: MetricsRow): void {
    this.upsertMetricsStmt.run({
      request_id: row.requestId,
      format: row.format,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      stop_reason: row.stopReason,
      streaming: row.streaming,
      tool_call_count: row.toolCallCount,
      cost: row.cost,
      parsed_at: row.parsedAt,
      message_count: row.messageCount,
      system_tokens: row.systemTokens,
      tools_defined: row.toolsDefined,
      tools_tokens: row.toolsTokens,
      cached_input_tokens: row.cachedInputTokens,
      cache_creation_input_tokens: row.cacheCreationTokens,
      kind: row.kind,
    });
  }

  replaceToolCalls(requestId: string, calls: readonly ToolCallInput[]): void {
    this.replaceToolCallsTxn(requestId, calls);
  }

  recordToolResult(toolId: string, bytes: number, tokens: number): void {
    this.recordToolResultStmt.run({ tool_id: toolId, bytes, tokens });
  }

  listSessions(): SessionSummary[] {
    const rows = this.listSessionsStmt.all() as Array<
      Omit<SessionSummary, "meta"> & { meta: string | null }
    >;
    return rows.map((row) => ({ ...row, meta: parseMeta(row.meta) }));
  }

  getSession(id: string): SessionDetail | undefined {
    const raw = this.getSessionStmt.get(id) as
      (Omit<SessionRow, "meta"> & { meta: string | null }) | undefined;
    if (!raw) return undefined;
    const session: SessionRow = { ...raw, meta: parseMeta(raw.meta) };
    const requests = this.getSessionRequestsStmt.all(id) as SessionRequest[];
    const analysis: SessionAnalysis = {
      toolUsage: this.toolUsageSessionStmt.all(id) as ToolUsage[],
      repeated: this.repeatedToolCallsStmt.all(id) as RepeatedToolCall[],
      growth: this.contextGrowthStmt.all(id) as GrowthPoint[],
      context: this.sessionContextStmt.get(id) as SessionContext,
      commands: commandBreakdown(this.bashToolCalls(id)),
    };
    return {
      session,
      requests,
      analysis,
    };
  }

  // Lean single-session lookup (no analysis queries). Used to rehydrate the
  // in-memory registry on a miss after a prune or restart.
  getSessionRow(id: string): SessionRow | undefined {
    const raw = this.getSessionStmt.get(id) as
      (Omit<SessionRow, "meta"> & { meta: string | null }) | undefined;
    if (!raw) return undefined;
    return { ...raw, meta: parseMeta(raw.meta) };
  }

  globalToolUsage(): ToolUsage[] {
    return this.toolUsageGlobalStmt.all() as ToolUsage[];
  }

  // Merge a patch into an existing session's meta (used to tag a session with,
  // e.g., a benchmark verify result after the run finishes). Returns false if
  // no such session exists.
  updateSessionMeta(id: string, patch: Record<string, string>): boolean {
    const row = this.getSessionStmt.get(id) as
      { meta: string | null } | undefined;
    if (!row) return false;
    const merged = { ...(parseMeta(row.meta) ?? {}), ...patch };
    this.db
      .prepare("UPDATE sessions SET meta = ? WHERE id = ?")
      .run(JSON.stringify(merged), id);
    return true;
  }

  updateSessionTitle(id: string, title: string): boolean {
    const row = this.getSessionStmt.get(id) as { id: string } | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE sessions SET title = ? WHERE id = ?")
      .run(title, id);
    return true;
  }

  updateSessionSummary(id: string, summary: string): boolean {
    const row = this.getSessionStmt.get(id) as { id: string } | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE sessions SET summary = ? WHERE id = ?")
      .run(summary, id);
    return true;
  }

  sessionIdsByMeta(key: string, value: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM sessions WHERE json_extract(meta, '$.' || ?) = ?",
      )
      .all(key, value) as { id: string }[];
    return rows.map((r) => r.id);
  }

  resolveSessionId(prefix: string): string | undefined {
    const rows = this.db
      .prepare("SELECT id FROM sessions WHERE id = ? OR id LIKE ? LIMIT 2")
      .all(prefix, `${prefix}%`) as { id: string }[];
    const exact = rows.find((r) => r.id === prefix);
    if (exact) return exact.id;
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  bashToolCalls(
    sessionId?: string,
  ): Array<{ arguments: string | null; result_tokens: number | null }> {
    const filter = "lower(tc.name) IN ('bash', 'shell', 'sh')";
    if (sessionId) {
      return this.db
        .prepare(
          `SELECT tc.arguments, tc.result_tokens FROM tool_calls tc
           JOIN requests r ON r.id = tc.request_id
           WHERE ${filter} AND r.session_id = ?`,
        )
        .all(sessionId) as Array<{
        arguments: string | null;
        result_tokens: number | null;
      }>;
    }
    return this.db
      .prepare(
        `SELECT tc.arguments, tc.result_tokens FROM tool_calls tc WHERE ${filter}`,
      )
      .all() as Array<{
      arguments: string | null;
      result_tokens: number | null;
    }>;
  }

  sessionToolCalls(sessionId: string): SessionToolCall[] {
    return this.sessionToolCallsStmt.all(sessionId) as SessionToolCall[];
  }

  requestTimestamps(): Array<{
    session_id: string;
    started_at: string;
    cache_creation_tokens: number;
  }> {
    return this.db
      .prepare(
        `SELECT r.session_id, r.started_at,
                COALESCE(m.cache_creation_input_tokens, 0) AS cache_creation_tokens
         FROM requests r
         LEFT JOIN metrics m ON m.request_id = r.id
         WHERE r.started_at IS NOT NULL AND r.keep_alive = 0
         ORDER BY r.session_id, r.started_at`,
      )
      .all() as Array<{
      session_id: string;
      started_at: string;
      cache_creation_tokens: number;
    }>;
  }

  projects(): Array<{
    cwd: string;
    repo: string | null;
    session_count: number;
    total_cost: number;
    total_tokens: number;
  }> {
    return this.db
      .prepare(
        `SELECT COALESCE(s.cwd, '') AS cwd,
                s.repo,
                COUNT(DISTINCT s.id) AS session_count,
                COALESCE(SUM(m.cost), 0) AS total_cost,
                COALESCE(SUM(m.input_tokens + m.output_tokens), 0) AS total_tokens
         FROM sessions s
         LEFT JOIN requests r ON r.session_id = s.id
         LEFT JOIN metrics m ON m.request_id = r.id
         WHERE s.last_seen_at IS NOT NULL
         GROUP BY s.cwd, s.repo
         HAVING session_count > 0
         ORDER BY total_cost DESC`,
      )
      .all() as Array<{
      cwd: string;
      repo: string | null;
      session_count: number;
      total_cost: number;
      total_tokens: number;
    }>;
  }

  sessionTimeline(
    days?: number,
  ): Array<{ date: string; sessions: number; requests: number; cost: number }> {
    const limit =
      days !== undefined
        ? `AND s.started_at >= datetime('now', '-${days} days')`
        : "";
    return this.db
      .prepare(
        `SELECT DATE(s.started_at) AS date,
                COUNT(DISTINCT s.id) AS sessions,
                COUNT(DISTINCT r.id) AS requests,
                COALESCE(SUM(m.cost), 0) AS cost
         FROM sessions s
         LEFT JOIN requests r ON r.session_id = s.id
         LEFT JOIN metrics m ON m.request_id = r.id
         WHERE s.started_at IS NOT NULL ${limit}
         GROUP BY DATE(s.started_at)
         ORDER BY date DESC`,
      )
      .all() as Array<{
      date: string;
      sessions: number;
      requests: number;
      cost: number;
    }>;
  }

  sessionLengths(): Array<{
    session_id: string;
    cwd: string;
    request_count: number;
    cost: number;
    input_tokens: number;
  }> {
    return this.db
      .prepare(
        `SELECT s.id AS session_id,
                COALESCE(s.cwd, '') AS cwd,
                COUNT(r.id) AS request_count,
                COALESCE(SUM(m.cost), 0) AS cost,
                COALESCE(SUM(m.input_tokens), 0) + COALESCE(SUM(m.output_tokens), 0) AS input_tokens
         FROM sessions s
         LEFT JOIN requests r ON r.session_id = s.id
         LEFT JOIN metrics m ON m.request_id = r.id
         WHERE r.id IS NOT NULL
         GROUP BY s.id
         ORDER BY request_count DESC`,
      )
      .all() as Array<{
      session_id: string;
      cwd: string;
      request_count: number;
      cost: number;
      input_tokens: number;
    }>;
  }

  deleteSession(id: string): void {
    const txn = this.db.transaction((sid: string) => {
      this.db
        .prepare(
          "DELETE FROM tool_calls WHERE request_id IN (SELECT id FROM requests WHERE session_id = ?)",
        )
        .run(sid);
      this.db
        .prepare(
          "DELETE FROM metrics WHERE request_id IN (SELECT id FROM requests WHERE session_id = ?)",
        )
        .run(sid);
      this.db.prepare("DELETE FROM requests WHERE session_id = ?").run(sid);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    });
    txn(id);
  }

  getRequest(id: string): RequestDetail | undefined {
    const row = this.getRequestStmt.get(id) as
      Omit<RequestDetail, "toolCalls" | "events"> | undefined;
    if (!row) return undefined;
    const toolCalls = this.getToolCallsStmt.all(id) as ToolCall[];
    return { ...row, toolCalls };
  }

  stats(): Stats {
    return this.statsStmt.get() as Stats;
  }

  kindBreakdown(): KindBreakdown[] {
    return this.kindBreakdownStmt.all() as KindBreakdown[];
  }

  rawQuery(sql: string, ...params: Array<string | number | null>): unknown[] {
    if (!isReadOnlyQuery(sql)) {
      throw new Error("Only read-only SELECT statements are allowed");
    }
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  recentSessions(limit = 100): Array<{
    id: string;
    client: string | null;
    cwd: string | null;
    repo: string | null;
    started_at: string | null;
    meta: string | null;
  }> {
    return this.db
      .prepare(
        "SELECT id, client, cwd, repo, started_at, meta FROM sessions ORDER BY last_seen_at DESC LIMIT ?",
      )
      .all(limit) as Array<{
      id: string;
      client: string | null;
      cwd: string | null;
      repo: string | null;
      started_at: string | null;
      meta: string | null;
    }>;
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "aap.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  ensureColumn(db, "tool_calls", "arguments", "TEXT");
  ensureColumn(db, "tool_calls", "tool_id", "TEXT");
  ensureColumn(db, "tool_calls", "result_bytes", "INTEGER");
  ensureColumn(db, "tool_calls", "result_tokens", "INTEGER");
  ensureColumn(db, "metrics", "message_count", "INTEGER");
  ensureColumn(db, "metrics", "system_tokens", "INTEGER");
  ensureColumn(db, "metrics", "tools_defined", "INTEGER");
  ensureColumn(db, "metrics", "tools_tokens", "INTEGER");
  ensureColumn(db, "metrics", "cached_input_tokens", "INTEGER");
  ensureColumn(db, "metrics", "cache_creation_input_tokens", "INTEGER");
  ensureColumn(db, "metrics", "kind", "TEXT");
  ensureColumn(db, "requests", "keep_alive", "INTEGER");
  ensureColumn(db, "sessions", "meta", "TEXT");
  ensureColumn(db, "sessions", "title", "TEXT");
  ensureColumn(db, "sessions", "summary", "TEXT");
  // Indexes on migrated columns must be created after the columns exist,
  // otherwise pre-existing databases fail before ensureColumn can run.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_id ON tool_calls (tool_id)",
  );
  return new Store(db);
}

function parseMeta(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

// Reject anything that isn't a plain SELECT — protects the raw_sql tool from
// injection via multi-statement strings, ATTACH, or write statements disguised
// with a SELECT prefix (e.g. "SELECT 1; DROP TABLE ...").
// String literals are stripped before keyword matching to avoid false positives
// (e.g. WHERE path LIKE '%DELETE%' is legitimate).
function isReadOnlyQuery(sql: string): boolean {
  const normalized = sql.trim().replace(/\s+/g, " ");
  if (!normalized.toUpperCase().startsWith("SELECT ")) return false;
  if (/;\s*\S/.test(normalized)) return false;
  // Remove string literals so keywords inside quotes don't trigger
  const withoutStrings = normalized.replace(/'[^']*'/g, "''");
  const upper = withoutStrings.toUpperCase();
  const forbidden = [
    "INSERT ",
    "UPDATE ",
    "DELETE ",
    "DROP ",
    "ALTER ",
    "CREATE ",
    "ATTACH ",
    "DETACH ",
    "PRAGMA ",
    "REPLACE ",
  ];
  return !forbidden.some((kw) => upper.includes(kw));
}

export { isReadOnlyQuery as _isReadOnlyQuery };

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
