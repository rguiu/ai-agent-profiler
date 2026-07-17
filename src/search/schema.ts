// search.sqlite schema — a derived, rebuildable index over raw NDJSON traces.
// Lives in its own database file so indexing never contends with the proxy's
// hot-path writes to aap.sqlite. Drop the file and re-run `aap index` to
// rebuild from traces (raw traces remain the source of truth).
//
// chunks      — one row per indexed text fragment (prompt, response, tool
//               call, tool result, error), deduplicated per session by
//               content hash so replayed conversation history is stored once.
// chunks_fts  — external-content FTS5 index over chunks (BM25 ranking).
//               Kept in sync via AFTER INSERT/DELETE triggers; chunk rows are
//               immutable (re-indexing deletes then re-inserts).
// index_state — per-request indexing ledger; makes indexing idempotent and
//               keyed by request_id, mirroring how parse tracks metrics.
export const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY,
  chunk_uid     TEXT NOT NULL UNIQUE,
  session_id    TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  ts            TEXT,
  kind          TEXT NOT NULL,
  role          TEXT,
  tool_name     TEXT,
  file_path     TEXT,
  model         TEXT,
  request_kind  TEXT,
  repo          TEXT,
  cwd           TEXT,
  client        TEXT,
  is_error      INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL,
  text          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_session_hash
  ON chunks (session_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_request ON chunks (request_id);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks (session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  tool_name,
  file_path,
  content='chunks',
  content_rowid='id',
  tokenize="unicode61 tokenchars '_'"
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text, tool_name, file_path)
  VALUES (new.id, new.text, new.tool_name, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text, tool_name, file_path)
  VALUES ('delete', old.id, old.text, old.tool_name, old.file_path);
END;

CREATE TABLE IF NOT EXISTS index_state (
  request_id  TEXT PRIMARY KEY,
  indexed_at  TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT
);
`;
