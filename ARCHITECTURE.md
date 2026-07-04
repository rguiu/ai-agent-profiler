# Architecture

This document records the high-level design of AI Agent Profiler and the reasoning behind each major decision. Read it (with `VISION.md`) before making changes, so that changes stay aligned with the project's intent.

The current focus is the **capture core**: reliably record raw, high-fidelity traces of agent ↔ provider traffic. Everything else (full REST API, Web UI, charts, analysis engine) is deferred until the data model is proven.

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
|  cli/      aap serve|run |
|  proxy/    listener, routing, passthrough + tee
|  session/  registry + control endpoint
|  capture/  async NDJSON sink, redaction
|  store/    sqlite index
|  parse/    off-hot-path metrics
|  config/   file + env loader
|  api/      minimal read endpoints (later)
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
6. **Parse (off hot path).** After the response completes, a parser reads the raw trace to extract model, token usage, stop reason, and tool calls, and computes cost from the pricing config, writing results back to SQLite.

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
sessions   (id, client, cwd, repo, started_at, first_seen_at, last_seen_at)
requests   (id, session_id, provider, method, path, trace_file,
            started_at, ended_at, status, latency_ms,
            request_bytes, response_bytes, error)
metrics    (request_id, format, model, input_tokens, output_tokens,
            stop_reason, streaming, tool_call_count, cost, parsed_at)
tool_calls (id, request_id, ordinal, name)
```

`requests` is written on the hot path during capture (M2). `metrics` and
`tool_calls` are derived off the hot path by `aap parse` (M3), which reads the
raw traces and is fully re-runnable and idempotent (keyed by `request_id`).
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

[pricing.anthropic."claude-...".]
input_per_mtok  = 0.0
output_per_mtok = 0.0
```

Pricing is never hardcoded in source.

---

## Security

- Localhost binding only. No telemetry, no cloud dependency.
- `authorization` and `x-api-key` headers are redacted before any trace is persisted.
- Config files that may hold secrets are gitignored.

---

## Explicitly deferred / out of scope for the capture core

Kept out until the raw data model is proven, per the "record first, analyse later" principle:

- Full REST API and Web UI (dashboard, session/request views, charts).
- Analysis engine (repeated prompts/files, context amplification, recommendations).
- Benchmark mode and MCP-specific analysis.
- Any behaviour-changing feature (response caching, MCP framework, request rewriting). These conflict with the "invisible proxy" principle and require explicit justification + opt-out defaults.

---

## Open items to validate

- Confirm Claude Code **and** Opencode both tolerate a base URL with a path prefix (they append `/v1/messages` etc.) and that routing/stripping is byte-exact. Validated in M1 before capture is built on top.
- Exact SQLite schema and NDJSON event shapes are finalised during M2/M3 against real captured traffic.
