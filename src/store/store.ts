import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { SessionInfo } from "../session/index.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  client        TEXT,
  cwd           TEXT,
  repo          TEXT,
  started_at    TEXT,
  first_seen_at TEXT,
  last_seen_at  TEXT
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
  error          TEXT
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
  parsed_at       TEXT
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
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_id ON tool_calls (tool_id);
`;

export interface RequestRow {
  id: string;
  sessionId: string;
  provider: string;
  method: string;
  path: string;
  traceFile: string;
  startedAt: string;
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
}

export interface MetricsRow {
  requestId: string;
  format: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  streaming: number;
  toolCallCount: number;
  cost: number | null;
  parsedAt: string;
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
  output_tokens: number;
  cost: number;
  tool_calls: number;
}

export interface SessionRow {
  id: string;
  client: string | null;
  cwd: string | null;
  repo: string | null;
  started_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
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
  output_tokens: number | null;
  stop_reason: string | null;
  cost: number | null;
  tool_call_count: number | null;
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
  output_tokens: number | null;
  stop_reason: string | null;
  streaming: number | null;
  tool_call_count: number | null;
  cost: number | null;
  parsed_at: string | null;
  toolCalls: ToolCall[];
  events?: unknown[];
}

export interface Stats {
  sessions: number;
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
  output_tokens: number | null;
}

export interface SessionAnalysis {
  toolUsage: ToolUsage[];
  repeated: RepeatedToolCall[];
  growth: GrowthPoint[];
}

export class Store {
  private readonly upsertSessionStmt;
  private readonly insertRequestStmt;
  private readonly finishRequestStmt;
  private readonly allTargetsStmt;
  private readonly pendingTargetsStmt;
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
  private readonly toolUsageGlobalStmt;
  private readonly toolUsageSessionStmt;
  private readonly repeatedToolCallsStmt;
  private readonly contextGrowthStmt;

  constructor(private readonly db: Database.Database) {
    this.upsertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, client, cwd, repo, started_at, first_seen_at, last_seen_at)
      VALUES (@id, @client, @cwd, @repo, @started_at, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        client       = COALESCE(excluded.client, sessions.client),
        cwd          = COALESCE(excluded.cwd, sessions.cwd),
        repo         = COALESCE(excluded.repo, sessions.repo),
        started_at   = COALESCE(sessions.started_at, excluded.started_at),
        last_seen_at = excluded.last_seen_at
    `);
    this.insertRequestStmt = db.prepare(`
      INSERT INTO requests (id, session_id, provider, method, path, trace_file, started_at)
      VALUES (@id, @session_id, @provider, @method, @path, @trace_file, @started_at)
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
      SELECT id, trace_file FROM requests WHERE trace_file IS NOT NULL
    `);
    this.pendingTargetsStmt = db.prepare(`
      SELECT r.id, r.trace_file FROM requests r
      LEFT JOIN metrics m ON m.request_id = r.id
      WHERE m.request_id IS NULL
        AND r.trace_file IS NOT NULL
        AND r.ended_at IS NOT NULL
    `);
    this.upsertMetricsStmt = db.prepare(`
      INSERT INTO metrics (request_id, format, model, input_tokens, output_tokens,
                           stop_reason, streaming, tool_call_count, cost, parsed_at)
      VALUES (@request_id, @format, @model, @input_tokens, @output_tokens,
              @stop_reason, @streaming, @tool_call_count, @cost, @parsed_at)
      ON CONFLICT(request_id) DO UPDATE SET
        format          = excluded.format,
        model           = excluded.model,
        input_tokens    = excluded.input_tokens,
        output_tokens   = excluded.output_tokens,
        stop_reason     = excluded.stop_reason,
        streaming       = excluded.streaming,
        tool_call_count = excluded.tool_call_count,
        cost            = excluded.cost,
        parsed_at       = excluded.parsed_at
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
      SELECT s.id, s.client, s.cwd, s.repo, s.started_at, s.first_seen_at, s.last_seen_at,
             COUNT(r.id) AS request_count,
             COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
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
             m.format, m.model, m.input_tokens, m.output_tokens, m.stop_reason,
             m.cost, m.tool_call_count
      FROM requests r
      LEFT JOIN metrics m ON m.request_id = r.id
      WHERE r.session_id = ?
      ORDER BY r.started_at
    `);
    this.getRequestStmt = db.prepare(`
      SELECT r.id, r.session_id, r.provider, r.method, r.path, r.trace_file,
             r.started_at, r.ended_at, r.status, r.latency_ms,
             r.request_bytes, r.response_bytes, r.error,
             m.format, m.model, m.input_tokens, m.output_tokens, m.stop_reason,
             m.streaming, m.tool_call_count, m.cost, m.parsed_at
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
        COALESCE((SELECT SUM(input_tokens) FROM metrics), 0) AS input_tokens,
        COALESCE((SELECT SUM(output_tokens) FROM metrics), 0) AS output_tokens,
        COALESCE((SELECT SUM(cost) FROM metrics), 0) AS cost
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
      SELECT r.id, r.started_at, m.input_tokens, m.output_tokens
      FROM requests r LEFT JOIN metrics m ON m.request_id = r.id
      WHERE r.session_id = ?
      ORDER BY r.started_at
    `);
  }

  upsertSession(info: SessionInfo): void {
    this.upsertSessionStmt.run({
      id: info.id,
      client: info.client ?? null,
      cwd: info.cwd ?? null,
      repo: info.repo ?? null,
      started_at: info.startedAt ?? null,
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
    });
  }

  replaceToolCalls(requestId: string, calls: readonly ToolCallInput[]): void {
    this.replaceToolCallsTxn(requestId, calls);
  }

  recordToolResult(toolId: string, bytes: number, tokens: number): void {
    this.recordToolResultStmt.run({ tool_id: toolId, bytes, tokens });
  }

  listSessions(): SessionSummary[] {
    return this.listSessionsStmt.all() as SessionSummary[];
  }

  getSession(id: string): SessionDetail | undefined {
    const session = this.getSessionStmt.get(id) as SessionRow | undefined;
    if (!session) return undefined;
    const requests = this.getSessionRequestsStmt.all(id) as SessionRequest[];
    const analysis: SessionAnalysis = {
      toolUsage: this.toolUsageSessionStmt.all(id) as ToolUsage[],
      repeated: this.repeatedToolCallsStmt.all(id) as RepeatedToolCall[],
      growth: this.contextGrowthStmt.all(id) as GrowthPoint[],
    };
    return { session, requests, analysis };
  }

  globalToolUsage(): ToolUsage[] {
    return this.toolUsageGlobalStmt.all() as ToolUsage[];
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
  return new Store(db);
}

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
