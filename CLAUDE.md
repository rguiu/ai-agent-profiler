# AI Agent Profiler — CLAUDE.md

## Build, test, lint

| Command                 | What                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run dev -- <args>` | Run CLI via `tsx` (dev, no build)                                      |
| `npm run build`         | `tsc -p tsconfig.json && cp -r src/hook/templates dist/hook/templates` |
| `npm run typecheck`     | `tsc --noEmit`                                                         |
| `npm test`              | `vitest run` (tests in `src/**/*.test.ts`)                             |
| `npm run test:watch`    | `vitest` (watch mode)                                                  |
| `npm run lint`          | `eslint .`                                                             |
| `npm run format`        | `prettier --write .`                                                   |
| `npm run format:check`  | `prettier --check .`                                                   |

**Quality gate** (what CI runs): `typecheck` → `lint` → `format:check` → `test` → `build`. Run these before marking work complete.

## Project overview

**AI Agent Profiler** is a local-first, read-only HTTP proxy profiler for AI coding agents (Claude Code, opencode). It sits between the agent and LLM providers (Anthropic, OpenAI, DeepSeek, OpenRouter, Ollama) recording high-fidelity traces to measure tool usage, files, context, and model behavior.

**Core principle:** record first, analyze later. The hot path (proxy) is byte-faithful with sub-millisecond overhead. All metrics are derived off the hot path from raw NDJSON traces.

## Architecture: pipeline layers

```
Proxy (hot) → Capture (async hot) → Store (hot)
                                      ↓
Parse (off-hot) → Analyze / Recommend / Search index (off-hot)
                                      ↓
API / UI / MCP (read-only, off-hot)
```

1. **`src/proxy/`** — HTTP/HTTPS proxy server. Routing, request passthrough, tee to capture, Bedrock SigV4 re-signing, request shape classification.
2. **`src/capture/`** — Async NDJSON trace capture. Never applies backpressure. Secrets redacted before persistence.
3. **`src/store/`** — SQLite via `better-sqlite3`. Plain SQL, no ORM. Tables: `sessions`, `requests`, `metrics`, `tool_calls`. Schema migrations via `ensureColumn`.
4. **`src/parse/`** — Reads raw traces, extracts tokens (incl. cache hits), cost, tool calls, message-stack breakdown. Idempotent (keyed by `request_id`).
5. **`src/analyze/`** — Shell-command classification, cache-regeneration detection, Claude Code transcript parsing.
6. **`src/recommend/`** — Per-session findings: repeated reads, redundant calls, high amplification.
7. **`src/search/`** — Full-text search index (FTS5) over raw traces in a separate `search.sqlite`. Idempotent indexing (keyed by `request_id`, deduped per session by content hash), off-hot-path (serve tick + `aap index`). Queried via REST `/search`, MCP tools, `aap search`, and the UI Search tab.
8. **`src/api/`** — REST endpoints: `/health`, `/sessions`, `/requests`, `/stats`, `/tools`, `/commands`, `/kinds`, `/search`.
9. **`src/ui/`** — Serves the static `web/` dashboard at `/ui`.
10. **`src/cli/`** — CLI entry (`aap.ts`) and subcommands: `serve`, `run`, `parse`, `index`, `search`, `sessions`, `commands`, `tag`, `export`, `compare`, `hook`, `install`, `mcp`.
11. **`src/config/`** — TOML config loader + Zod schema. Resolution: `$AAP_CONFIG` → `~/.aap/config.toml` → `./config.toml`.
12. **`src/hook/`** — Shell hook install system + wrapper templates (`git.sh`, `grep.sh`, `ls.sh`, etc.).
13. **`src/session/`** — Session registry for active sessions.

## Key conventions

- **Runtime:** Node >= 20, ESM (`"type": "module"`), TypeScript strict mode.
- **Zero-framework web:** `web/` is vanilla HTML/CSS/JS — no React, no bundler.
- **No ORM:** All DB access is hand-written SQL via `better-sqlite3` in `src/store/store.ts`.
- **No MITM:** Proxy is a base-URL reverse proxy (not a CA-cert interception proxy).
- **Provider-agnostic:** Adding a provider is config-only (TOML `[providers.*]` + `[pricing.*]`).
- **Secrets:** `authorization` and `x-api-key` headers are redacted before any persistence.
- **Localhost only.** No telemetry, no cloud dependency.
- **Pricing never hardcoded:** Always read from config.
- **Raw traces are authoritative:** SQLite index can always be rebuilt via `aap parse`.
- **Git dependencies:** The `rg` (ripgrep) command is intercepted by shell hooks. Use the tool-native `Grep`/`Glob` tools instead of raw `rg`/`grep`/`find` for file operations.
- **Test files:** `src/**/*.test.ts`, Vitest. Tests are unit-level; SQLite tests use in-memory DB.
- **npm scripts assume `tsx` globally available.** If missing: `npm install -D tsx`.
