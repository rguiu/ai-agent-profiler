# Architecture

This document records the high-level design of AI Agent Profiler and the reasoning behind each major decision. Read it (with `VISION.md`) before making changes, so that changes stay aligned with the project's intent.

The **capture core is complete** — the profiler reliably records raw, high-fidelity traces of agent ↔ provider traffic — and a **first analysis layer** is built on top of it: derived metrics, a read API, a web dashboard, recommendations, command-usage and message-stack analysis, export, compare, and an MCP server. The guiding principle still holds: capture stays on the hot path and pure; everything derived is computed off it from the raw traces. The only things still deferred are the research capabilities and any (optional, opt-in) behaviour-changing "optimize" mode.

---

## Design principles

1. **The proxy is invisible.** It never modifies requests or responses. Observe, record, analyse — nothing more.
2. **Never block the hot path.** Streaming tokens must reach the agent unbuffered. Capture happens off to the side, asynchronously. Target: sub-millisecond added overhead, no buffering.
3. **Record raw, derive later.** Persist high-fidelity traces cheaply; compute metrics off the hot path and re-derive as research questions change.
4. **Local-first, zero telemetry.** Localhost only. No cloud dependency. Never expose API keys.
5. **Provider- and agent-agnostic.** Adding a provider or agent should be configuration, not a rewrite.

---

## Locked decisions

| Area             | Decision                                                    | Why                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | **Node + TypeScript**                                       | Strong streaming primitives; one language shared with the future React/TS UI, including shared data-model types. Chosen over Go for maintainability by the author; over Python for the unified stack. |
| Interception     | **Base-URL reverse proxy**                                  | Agents point their provider base URL at the profiler. No CA cert / MITM. Works with Claude Code + Opencode base-URL overrides.                                                                        |
| Proxy hop        | **Native `node:http`/`https`**                              | Byte-faithful passthrough, no header normalization, zero deps. Fidelity matters for a profiler.                                                                                                       |
| Routing          | **Single port, path `/<session_id>/<provider>/...`**        | One port to manage; provider and session both read from the URL.                                                                                                                                      |
| Session identity | **Launcher wrapper injects `session_id`**                   | The only reliable way to distinguish concurrent agents (e.g. multiple terminal tabs). Passive signals (source port, headers) are unreliable.                                                          |
| cwd / repo       | **Captured by the wrapper** (best-effort, nullable)         | The wrapper runs in the user's shell, where cwd + git context actually exist. The proxy alone cannot see them.                                                                                        |
| Raw storage      | **Per-session append-only NDJSON + SQLite index**           | Cheapest possible capture, zero hot-path DB contention, highest fidelity. Index holds metadata + byte offsets.                                                                                        |
| Structured store | **SQLite via `better-sqlite3`**                             | Fast, simple, single-file. Plain SQL, no ORM.                                                                                                                                                         |
| Config           | **TOML/YAML file + env overrides**                          | Human-editable routes + pricing tables (pricing must not be hardcoded). Env overrides ports/secrets.                                                                                                  |
| Secrets          | **Redact `authorization` / `x-api-key` before persistence** | Never store API keys. Redaction on by default.                                                                                                                                                        |

---

## Component overview

```
+--------------------------+
| Claude Code / Opencode   |
| (launched via `aap run`) |
+------------+-------------+
             |  ANTHROPIC_BASE_URL=http://localhost:8080/<session_id>/anthropic
             v
+--------------------------+
| AI Agent Profiler        |
|                          |
|  cli/      aap serve|run|parse|sessions|commands|tag|export|compare|mcp|config
|  proxy/    listener, routing, passthrough + tee, /health + /_control
|  session/  registry + control endpoint
|  capture/  async NDJSON sink, redaction
|  store/    sqlite index
|  parse/    off-hot-path metrics + message-stack breakdown
|  analyze/  pure shell-command classifier + categories
|  recommend/ per-session findings (amplification, duplication, search→read...)
|  api/      read endpoints (/sessions, /requests, /stats, /tools, /commands)
|  config/   file + env loader
|  ui/       static web dashboard (/ui)
+------------+-------------+
             |  byte-faithful passthrough (prefix stripped)
             v
+--------------------------+
| Anthropic / OpenAI /     |
| DeepSeek / OpenRouter /  |
| Ollama (OpenAI-compat)   |
+--------------------------+
```

---

## Request lifecycle

1. **Launch.** `aap run claude` generates a `session_id` (UUID), reads cwd + git repo/remote, registers `{session_id, cwd, repo, client, started_at}` with the proxy's local control endpoint, sets provider base URLs to `http://localhost:<port>/<session_id>/<provider>`, then `exec`s the real agent.
2. **Ingress.** A request arrives at the single listener. The proxy parses `session_id` and `provider` from the path prefix and looks up the upstream URL in config.
3. **Passthrough.** The proxy strips `/<session_id>/<provider>` and forwards the remaining path (e.g. `/v1/messages`) upstream over HTTPS, byte-for-byte. The upstream response streams straight back to the agent, unbuffered.
4. **Tee (async).** In parallel, request bytes and the response stream are teed into an async capture sink (a `PassThrough`) that writes NDJSON to the session's trace file. This never applies backpressure to the client stream.
5. **Index.** Metadata rows (session, request, response) with file pointers + timing are written to SQLite.
6. **Parse (off hot path).** A parser reads the raw trace to extract model, token usage (including provider prompt-cache hit tokens), stop reason, tool calls, and context composition (message count, system-prompt and tool-definition tokens), and computes cost from the pricing config, writing results back to SQLite. It runs re-runnably via `aap parse` and automatically on a low-frequency background tick inside `aap serve`, so finished requests become metrics without a manual step — never on the request hot path.
7. **Read & analyse (off hot path).** The read API (`api/`), MCP server, and `/ui` derive everything on demand from the indexed metrics and the raw traces: per-session recommendations, tool-result amplification, context growth, the shell-command breakdown, and a per-request message-stack composition (`GET /requests/:id/messages`).

**Fallback:** a request without the `/<session_id>/` prefix (agent run directly, no wrapper) is attributed to a synthetic "unattributed" session, grouped by an idle-timeout window.

---

## Storage model

**Raw traces (source of truth).** Append-only NDJSON, one directory per session:

```
traces/<session_id>/<request_id>.ndjson
```

Each line is one event: `request`, `request_body`, `response`, `response_body`, `error`, `end` (a terminal summary with status, latency, and byte totals). Secrets are redacted before writing.

**SQLite index (derived, queryable).** Plain SQL, no ORM. Current tables:

```
sessions   (id, client, cwd, repo, meta, started_at, first_seen_at, last_seen_at)
requests   (id, session_id, provider, method, path, trace_file,
            started_at, ended_at, status, latency_ms,
            request_bytes, response_bytes, error)
metrics    (request_id, format, model, input_tokens, cached_input_tokens,
            output_tokens, stop_reason, streaming, tool_call_count, cost,
            parsed_at, message_count, system_tokens, tools_defined, tools_tokens)
tool_calls (id, request_id, ordinal, name, arguments,
            tool_id, result_bytes, result_tokens)
```

`requests` is written on the hot path during capture (M2). `metrics` and
`tool_calls` are derived off the hot path — by `aap parse` and by the background
parse tick in `aap serve` — reading the raw traces; both are fully re-runnable and
idempotent (keyed by `request_id`). New columns are added by lightweight
`ensureColumn` migrations, so an existing index upgrades in place.
The SQLite index can always be rebuilt from the raw traces. Traces are authoritative.

---

## Configuration

A single TOML/YAML file defines provider routes, upstream URLs, and pricing tables; env vars override ports/secrets. Example shape:

```toml
[server]
port = 8080

[providers.anthropic]
upstream = "https://api.anthropic.com"

[providers.openai]
upstream = "https://api.openai.com"

[pricing."claude-3-5-sonnet-20241022"]
inputPerMTok  = 3.0
outputPerMTok = 15.0
```

Pricing is never hardcoded in source.

---

## Security

- Localhost binding only. No telemetry, no cloud dependency.
- `authorization` and `x-api-key` headers are redacted before any trace is persisted.
- Config files that may hold secrets are gitignored.

---

## Custom metadata

External tools (e.g. Armada, benchmark harnesses) can tag captured traffic with their own
context — run id, task id, node name, experiment label. This metadata is recorded **for the
profiler only** and is **never forwarded to the LLM**, so it stays behaviour-neutral.

1. **Session-level metadata — via the control API (implemented).**
   `POST /_control/sessions` accepts an arbitrary `meta` map:

   ```
   POST /_control/sessions
   { "id": "<session>", "meta": { "armada_node": "n3", "task": "t42", "iter": "1" } }
   ```

   `aap run` populates it from `--meta key=value` flags plus `AAP_META_*` env vars and
   `ARMADA_NODE_NAME`. It is a pure side channel to the proxy — it never touches provider
   traffic — so it works regardless of what the agent supports. Stored as a `meta` JSON
   column on `sessions`; surfaced in the read API, `/ui`, and MCP `get_session`. A session's
   meta can also be **merged after the fact** with `aap tag <session> key=value`
   (`store.updateSessionMeta`) — used by the benchmark harness to record a `verify=pass|fail`
   result once a task has been scored. A caller may pin the session id up front via
   `AAP_SESSION_ID` so the run and its later tag refer to the same session.

2. **Per-request metadata — via reserved `x-aap-*` headers (deferred).**
   The client sets headers under a reserved prefix; the proxy would record them as request
   metadata and **strip all `x-aap-*` headers before forwarding upstream**. _Caveat:_ depends
   on the agent being able to inject custom outbound headers — unverified for Claude Code /
   Opencode, so channel 1 leads and channel 2 remains future work.

---

## Explicitly deferred / out of scope

Per the "record first, analyse later" principle, and the read-only invariant:

- **Ordered behavioural analysis** that needs signals not yet captured — e.g. "was a tool result actually referenced later?" (for pruning/summarisation evidence), and ordered `search → read(same file)` sequence detection (the current `inefficient_search` heuristic is aggregate co-occurrence).
- **Multi-run benchmark aggregation** — distributions/scoring across repeated runs of the same task (single-run verify + tagging is done).
- **MCP-server analysis** — call frequency, payload sizes, and token impact of an agent's _own_ MCP servers (distinct from our `aap mcp` introspection server).
- **Any behaviour-changing feature** (response caching, MCP framework, request rewriting, an "optimize" mode that prunes/compacts the wire). These conflict with the "invisible proxy" principle; if ever built they must be an explicit, off-by-default `--optimize` mode, justified by a baseline metric and never regressing task success. See [`docs/aish-requirements.md`](docs/aish-requirements.md).

---

## Open items to validate

- **Opencode + DeepSeek** is validated end-to-end (base URL with a path prefix, byte-exact routing/stripping, capture → parse → analysis). The **Claude Code** path is built but not yet formally confirmed against a live run.
- The SQLite schema and NDJSON event shapes are stable against real captured traffic; further columns are added via in-place `ensureColumn` migrations rather than rewrites.
