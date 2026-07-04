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

export class Store {
  private readonly upsertSessionStmt;
  private readonly insertRequestStmt;
  private readonly finishRequestStmt;

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
