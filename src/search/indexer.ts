import { readTraceEvents } from "../parse/index.js";
import type { SearchIndexTarget, Store } from "../store/index.js";
import { extractChunks, type ChunkSource } from "./extract.js";
import type { SearchStore } from "./search-store.js";

export interface IndexSummary {
  total: number;
  indexed: number;
  failed: number;
  chunks: number;
}

export interface IndexOptions {
  // Re-index every parsed request, replacing prior chunks. Default: only
  // requests not yet recorded in index_state.
  all?: boolean;
  // Bound the number of requests processed in one run (used by the serve
  // tick to keep each pass short). Unlimited when omitted.
  limit?: number;
}

function toSource(target: SearchIndexTarget): ChunkSource {
  return {
    requestId: target.id,
    sessionId: target.session_id,
    ts: target.started_at,
    model: target.model,
    provider: target.provider,
    requestKind: target.request_kind,
    repo: target.repo,
    cwd: target.cwd,
    client: target.client,
  };
}

// Off-hot-path and idempotent: reads parsed requests from aap.sqlite,
// re-derives chunks from the raw NDJSON traces, and writes them to
// search.sqlite. Safe to run concurrently with `aap serve` (separate DB,
// WAL, per-request transactions) and safe to re-run at any time.
export async function runIndex(
  store: Store,
  search: SearchStore,
  opts: IndexOptions = {},
): Promise<IndexSummary> {
  const done = opts.all ? new Set<string>() : search.indexedRequestIds();
  let targets = store.searchIndexTargets().filter((t) => !done.has(t.id));
  if (opts.limit !== undefined) targets = targets.slice(0, opts.limit);

  let indexed = 0;
  let failed = 0;
  let chunks = 0;
  for (const target of targets) {
    try {
      const events = await readTraceEvents(target.trace_file);
      const drafts = extractChunks(events, toSource(target));
      chunks += search.indexRequest(target.id, toSource(target), drafts);
      indexed++;
    } catch (err) {
      failed++;
      search.markFailed(target.id, (err as Error).message);
      console.error(`index: ${target.id} failed: ${(err as Error).message}`);
    }
  }
  return { total: targets.length, indexed, failed, chunks };
}
