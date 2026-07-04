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
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  name       TEXT NOT NULL
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

export class Store {
  private readonly upsertSessionStmt;
  private readonly insertRequestStmt;
  private readonly finishRequestStmt;
  private readonly allTargetsStmt;
  private readonly pendingTargetsStmt;
  private readonly upsertMetricsStmt;
  private readonly deleteToolCallsStmt;
  private readonly insertToolCallStmt;
  private readonly replaceToolCallsTxn: (
    requestId: string,
    names: readonly string[],
  ) => void;

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
      INSERT INTO tool_calls (request_id, ordinal, name)
      VALUES (@request_id, @ordinal, @name)
    `);
    this.replaceToolCallsTxn = db.transaction(
      (requestId: string, names: readonly string[]) => {
        this.deleteToolCallsStmt.run(requestId);
        names.forEach((name, ordinal) => {
          this.insertToolCallStmt.run({ request_id: requestId, ordinal, name });
        });
      },
    );
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

  replaceToolCalls(requestId: string, names: readonly string[]): void {
    this.replaceToolCallsTxn(requestId, names);
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
  return new Store(db);
}
