# Roadmap

Priorities for AI Agent Profiler. The near-term focus is the **capture core** — reliably recording raw, high-fidelity traces. Analysis, API, and UI are deliberately deferred until the data model is proven against real traffic.

See `VISION.md` for _why_ and `ARCHITECTURE.md` for _how_.

---

## Now: Capture Core

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
- [ ] **Validate** Claude Code and Opencode both work end-to-end through the prefixed base URL with zero behaviour change (manual: needs the agents + provider credentials).

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

- [ ] `GET /health`, `GET /sessions`, `GET /sessions/:id`.
- [ ] Enough to inspect captured data and validate the schema.

**Done when:** captured sessions can be listed and inspected via the API.

---

## Later: Analysis & Presentation (deferred)

Only after the capture core is solid.

- **REST API** — complete the endpoints (`/requests/:id`, `/metrics`, `/stats`, search).
- **Web UI** — dashboard, sessions, session detail, request detail, metrics. Framework/charts chosen then (React/TS is the default, revisit vs lighter options). Dark mode by default.
- **Search** — by prompt, filename, model, tool, repository.
- **Export** — session as JSON / Markdown.

---

## Future: Research capabilities (not MVP)

The reason the project exists — enabled by the raw traces captured above.

- **Analysis engine** — detect repeated prompts, repeated files, repeated tool calls, large context growth, potential optimisations.
- **Context analysis** — repeated / unused context, context amplification.
- **Tool efficiency** — output bytes, estimated prompt tokens, execution time, downstream token cost, subsequent tool dependencies.
- **MCP analysis** — servers used, call frequency, payload sizes, latency, token impact.
- **Benchmark mode** — run identical tasks across Claude Code / Opencode / AISH; comparison reports.
- **Recommendations** — e.g. "this directory listing generated 5,800 prompt tokens", "the same file was read 12 times", "replacing shell search with structured symbol lookup could reduce prompt size by 80%".

---

## Non-goals

- Not an observability dashboard, enterprise proxy, or LLM profiler.
- No behaviour-changing features (response caching, MCP framework, request rewriting) unless optional, disabled by default, and justified by measurement.
