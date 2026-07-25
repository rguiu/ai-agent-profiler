# Observability Improvements

Observability improvements mapped to AAP's local-first proxy architecture.

## Gap Analysis Summary

| Concept                                                                               | AAP Status                                                | Gap                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Hierarchical spans (`gen_ai.invoke_agent` → `gen_ai.request` → `gen_ai.execute_tool`) | Requests + tool_calls tracked separately, no parent-child | Need `parent_span_id` for tree visualization                      |
| Tool error rates                                                                      | Tool calls tracked, no success/failure classification     | Need error classification on tool results                         |
| Model comparison dashboard                                                            | Cost-by-model possible via SQL, no dedicated UI           | Need new `/models` endpoint + UI page                             |
| Latency percentiles (p50/p95)                                                         | `latency_ms` per request stored, no aggregation           | Need percentile computation in SQL                                |
| Trend lines (cache hit rate, token efficiency over time)                              | Point-in-time stats only                                  | Need time-bucketed stats endpoint                                 |
| Cost by project/repo                                                                  | Sessions have `cwd`/`repo`, no aggregation view           | Need `/projects` endpoint + UI widget                             |
| Agent error rate                                                                      | HTTP errors tracked, no agent-level errors                | Need error classification (tool failure, timeout, invalid output) |
| Waterfall/timeline view                                                               | Sequential request list, no timing visualization          | Need request-level waterfall with tool call sub-spans             |

## Phase 1: Foundation (Schema + Parse)

### 1.1 Tool error classification

**Schema**: Add `error` (TEXT, nullable) to `tool_calls` table.

**Parser changes** (`src/parse/parse.ts`):

- Classify tool results as success/error/timeout at parse time
- Heuristics: result content containing error patterns (`"error"`, `"failed"`, `"timeout"`, exit code != 0), HTTP error codes in results, empty/null results

```typescript
export type ToolResultStatus = "success" | "error" | "timeout" | "unknown";

export interface ToolResultError {
  status: ToolResultStatus;
  message?: string;
}
```

### 1.2 Latency percentile SQL

**API**: Add `latency` field to `/stats` response with p50/p95 per model and per kind.

```sql
-- Per-model latency percentiles (SQLite approximation via ntile)
SELECT model,
       MIN(latency_ms) AS p50,
       MAX(CASE WHEN ntile <= 19 THEN latency_ms END) AS p95
FROM (
  SELECT m.model, r.latency_ms,
         NTILE(20) OVER (PARTITION BY m.model ORDER BY r.latency_ms) AS ntile
  FROM requests r JOIN metrics m ON m.request_id = r.id
  WHERE r.latency_ms IS NOT NULL AND r.latency_ms > 0
) GROUP BY model;
```

### 1.3 Cache hit rate trend

**API**: `/stats/trend?days=30` — daily cache hit rate over time.

```sql
SELECT DATE(r.started_at) AS date,
       COALESCE(SUM(m.cached_input_tokens), 0) AS cached,
       COALESCE(SUM(m.input_tokens + m.cached_input_tokens), 0) AS total
FROM requests r JOIN metrics m ON m.request_id = r.id
WHERE r.started_at >= datetime('now', '-30 days')
GROUP BY DATE(r.started_at) ORDER BY date;
```

## Phase 2: New API Endpoints

### 2.1 `GET /models` — Cross-session model comparison

Returns per-model aggregated stats across all sessions:

- Model name, provider
- Request count, session count
- Total tokens (input/cached/output/cache_creation)
- Cost total
- Latency p50/p95/p99
- Cache hit rate
- Tool call count

### 2.2 `GET /projects` — Cost by project/repo

Already exists as `Store.projects()`. Needs API endpoint and UI widget.

### 2.3 `GET /stats/latency` — Latency percentiles

Per-model and per-kind latency percentiles.

### 2.4 `GET /stats/trend?days=30&metric=cache_hit|cost|tokens` — Trend data

Time-bucketed metrics for trend line charts.

## Phase 3: UI Additions

### 3.1 Model comparison page (`#/models`)

New nav tab. Shows:

- Table: model, provider, requests, sessions, total cost, avg cost/req, p50/p95 latency, cache hit rate
- Bar chart: cost by model
- Bar chart: latency by model (p50/p95 grouped)
- Line chart: cost trend by model over time

### 3.2 Dashboard additions

- **Latency card**: p50/p95 global latency
- **Cache trend sparkline**: Last 7 days of cache hit rate
- **Projects widget**: Cost by project/repo (top 10)

### 3.3 Session detail additions

- **Tool reliability**: Per-tool error rate in the tool usage table
- **Latency column**: p50/p95 in the request list

## Phase 4: Span Hierarchy (Future)

Requires significant schema change. Add `span_id`, `parent_span_id` to `tool_calls` table. Allows waterfall visualization. TBD after Phase 1-3 bake.

## Implementation Order

1. Schema migration: `tool_calls.error` column
2. Parse: classify tool result errors
3. Store: new queries (latency percentiles, model comparison, trends)
4. API: new endpoints (`/models`, `/stats/latency`, `/stats/trend`, `/projects`)
5. UI: model comparison page, dashboard widgets, session detail enhancements
