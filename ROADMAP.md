# Roadmap

The **capture core is complete** — the profiler captures, parses, and surfaces real agent
traffic today (verified with live opencode + DeepSeek sessions). Work now continues on
analysis, presentation, and the research capabilities that are the project's reason to exist.

See `VISION.md` for _why_ and `ARCHITECTURE.md` for _how_.

---

## Done: Capture Core (M0–M4)

### M0 — Scaffold & docs

- [x] Move seed docs to gitignored `notes/`.
- [x] `.gitignore`.
- [x] `VISION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `README.md`.
- [x] Node + TypeScript project: `package.json`, `tsconfig`, dev runner (`tsx`), tests (`vitest`), lint/format (eslint + prettier).
- [x] Config loader (TOML/YAML file + env overrides), `config.example.toml`.

**Done when:** `npm test` / lint / typecheck run green on an empty skeleton and config loads.

### M1 — Transparent passthrough + launcher

- [x] Single-port listener; path routing `/<session_id>/<provider>/...`.
- [x] Byte-faithful streaming passthrough (request + SSE response), unbuffered, correct headers/status/error propagation.
- [x] `aap serve` (start proxy) and `aap run <agent>` (wrapper: session_id + cwd/repo, set base URLs, exec agent).
- [x] **Validated** end-to-end with real **opencode + DeepSeek** (captured sessions tagged `client: opencode`). Claude Code path is built but not yet formally confirmed.

**Done when:** a real Claude Code / Opencode session runs through the proxy indistinguishably from a direct connection.

### M2 — Raw capture

- [x] Async tee → per-session NDJSON trace files; never blocks the client stream.
- [x] Session/request IDs derived from the URL; unattributed-session fallback.
- [x] Redaction of `authorization` / `x-api-key` before persistence.
- [x] SQLite index: session + request rows with trace pointers + timing (detailed response parsing lands in M3).

**Done when:** every request in a session is captured with zero data loss versus the raw stream.

### M3 — Off-hot-path parsing & metrics

- [x] `aap parse` extracts model, token usage, stop reason, and tool calls from raw traces → SQLite (`metrics`, `tool_calls`). Anthropic + OpenAI, streaming and non-streaming, gzip/br decoding.
- [x] Cost estimation from the pricing config.
- [x] Re-runnable and idempotent (keyed by `request_id`); `--all` reparses everything. Metrics are always reproducible from the raw traces.

**Done when:** per-request token/cost/tool metrics are queryable and match the raw traces.

### M4 — Minimal read surface

- [x] `GET /health`, `GET /sessions`, `GET /sessions/:id`, `GET /requests/:id` (`?events=1` for raw trace events), `GET /stats`.
- [x] Enough to inspect captured data and validate the schema.

**Done when:** captured sessions can be listed and inspected via the API.

---

## Later: Analysis & Presentation

- [x] **Read API** — `/health`, `/sessions`, `/sessions/:id`, `/requests/:id` (`?events=1`), `/requests/:id/messages`, `/stats`, `/tools`, `/commands`.
- [x] **Web UI** — dark-mode dashboard at `/ui`: tool-usage bars, shell-command breakdown, sessions, session detail (context-growth chart, tool usage, repeated tool calls, context cost, shell commands), request detail with reconstructed response, per-tool result tokens, and a per-request message-stack split view. No framework. _Remaining: latency/cost-over-time charts, live auto-refresh._
- [x] **MCP server** (`aap mcp`) — 10 stdio tools for agent self-introspection: `list_sessions`, `get_session`, `get_request`, `search_requests`, `recommend`, `compare`, `stats`, `top_tools`, `command_breakdown`, `raw_sql`.
- [~] **Search** — by model, tool, provider (via MCP `search_requests` + `raw_sql`). _Remaining: UI search bar; full-text search over prompts/filenames._
- [x] **Export** — session report as Markdown or JSON via `aap export <id> [--json]`.
- [~] **Custom run metadata** — session-level tags via the control API and `aap run --meta key=value` (plus `AAP_META_*` env vars and `ARMADA_NODE_NAME`), stored on the session and never sent to the LLM. Per-request `x-aap-*` header channel still deferred.

---

## Delivered beyond the original plan

Shipped while building the above, not in the M0–M4 scope:

- Agent **self-introspection via MCP** (`aap mcp`).
- **Live per-request logging** in the `aap serve` terminal.
- **Run-from-anywhere** config resolution (`$AAP_CONFIG` → `~/.config/aap/config.toml` → `./config.toml`).
- **opencode routing** via injected `OPENCODE_CONFIG_CONTENT` (per-run session ids without editing `opencode.json`).
- **Tool-call arguments** capture and a request **`Started`** timestamp column.

---

## Future: Research capabilities (not MVP)

The reason the project exists — enabled by the raw traces captured above.

- [~] **Analysis engine** — detect repeated prompts, repeated files, repeated tool calls, large context growth, potential optimisations. _(Done: tool usage, repeated tool calls by argument, context-growth series, global tool usage via `/tools`.)_
- [~] **Context analysis** — repeated / unused context, context amplification. _(Done: per-request system-prompt tokens, message count, and tool-definition tokens, plus per-session totals showing cumulative duplication of the static system + tools payload. Also captures provider prompt-cache hit tokens (`metrics.cached_input_tokens`) so the `context_duplication` recommendation is cache-aware.)_
- [~] **Tool efficiency** — output bytes, estimated prompt tokens, execution time, downstream token cost, subsequent tool dependencies. _(Done: tool-result token amplification — each tool call linked to its result in the next request with byte/token size.)_
- [ ] **MCP-server analysis** — for MCP servers an agent uses: call frequency, payload sizes, latency, token impact. (Distinct from our own `aap mcp` introspection server, which is done.)
- [~] **Benchmark mode** — run identical tasks across Claude Code / Opencode / AISH; comparison reports. _(Started: `aap compare <ids...>` and the `compare` MCP tool produce side-by-side session reports — the comparison half. The task-runner harness (headless invocation, workspace reset, verify command) is still pending and depends on the custom-metadata channel.)_
- [x] **Recommendations** — actionable findings from the analysis: repeated file reads, redundant tool calls, high token amplification, static context duplication, context growth. Exposed via the API, the `/ui` session page, the `recommend` MCP tool, and `aap export`.
- [x] **Message-stack breakdown** — per request, split the sent context by element type (system / user / assistant / tool) with size + token estimate each, to see exactly what is re-sent every call. _Via a derived `GET /requests/:id/messages` endpoint (computed from the stored trace) and a collapsible split view on the `/ui` request page._
- [x] **Command-usage analysis** — which shell programs the agent runs through `bash`, how often, and for what (category: search / read / vcs / build / nav / other), with result-token weight. _Via `aap commands` (session-scoped), a `GET /commands` endpoint, and a `/ui` panel. Evidence for AISH capability #9._
- [x] **Inefficient search→read detection** — flag locate-type shell commands (`find`/`ls`/`grep`) that co-occur with separate file reads, as evidence for a repo-aware locate-and-read tool. _First cut done via the `inefficient_search` recommendation (aggregate co-occurrence). Evidence for AISH capability #10._
- [ ] **Ordered search→read sequence detection** — tighten the above from aggregate co-occurrence to an actual ordered `locate → read(same file)` chain, for stronger evidence.

---

## Non-goals

- Not an observability dashboard, enterprise proxy, or LLM profiler.
- No behaviour-changing features (response caching, MCP framework, request rewriting) unless optional, disabled by default, and justified by measurement.
