# AI Agent Profiler

A **local-first, read-only profiler for AI coding agents**.

It sits as a transparent proxy between a coding agent (Claude Code, Opencode) and an LLM provider (Anthropic, OpenAI-compatible), and records high-fidelity traces of every interaction so you can measure how the agent uses tools, files, context, and models.

It is a **performance profiler for autonomous coding agents** — not an observability dashboard, not an enterprise proxy, not an LLM profiler. See [`VISION.md`](VISION.md).

> Status: **capture core complete** — transparent proxy, raw trace capture, derived metrics, a read API, and a minimal web dashboard all work. Charts, search/export, and analysis are next. See [`ROADMAP.md`](ROADMAP.md).

## Features

Working now (capture core):

- Transparent, byte-faithful HTTP(S) proxy — never modifies requests.
- Per-session raw trace capture (requests, responses, streaming events, timing) with secret redaction.
- Token, latency, cost, and tool metrics derived from raw traces (`aap parse`).
- Read API + a minimal dark-mode web dashboard at `/ui`.
- First insights: tool usage, repeated tool calls (by argument), per-session context growth, tool-result **token amplification**, and **context composition** (message count, system-prompt size, tool-definition tokens per request + duplicated totals per session).
- **Recommendations** — actionable findings per session (repeated file reads, redundant tool calls, high amplification, context duplication, context growth).
- **Export** — a session report as Markdown (or JSON) via `aap export`.
- **MCP server** (`aap mcp`) — 10 tools exposing the profiler's data to an AI agent for self-introspection (list_sessions, get_session, get_request, search_requests, recommend, compare, stats, top_tools, command_breakdown, raw_sql).
- Per-request logging in the `aap serve` terminal.

Planned:

- Web UI, search, and export.
- Analysis engine (repeated context/files, tool efficiency, recommendations).

## Dashboard preview

The dark-mode dashboard at `/ui`:

![AI Agent Profiler dashboard](docs/dashboard.png)

A session page surfaces the analysis and recommendations:

```
Sessions / 5d11f321
Session 5d11f321      client opencode      cwd .../book

Recommendations
  | HIGH  webfetch results added ~32,482 tokens to context
  |       Across 10 calls this output entered later prompts -- summarise it.
  | HIGH  Tool definitions re-sent on every request (~96,390 tokens total)
  | INFO  Context grew from ~607 to ~63,522 tokens (104x over 17 requests)

Context growth (input tokens per request, max ~63,522)
  63k |                                             .------
      |                                    .--------'
  30k |                     .--------------'
      |        .------------'
   0  +--------'

Requests
  #  Started    Provider  Model            Status  Latency   In       Tools
  1  22:07:42   deepseek  deepseek-v4-pro    200    8.4s      607        0
  7  22:40:08   deepseek  deepseek-v4-pro    200    5.2s      16,905     2
```

## How it works

You launch your agent through a small wrapper that points its provider base URL at the profiler and tags the session:

```
aap run claude       # or: aap run opencode
```

The profiler streams traffic through untouched, tees a copy to append-only trace files, and indexes metadata in SQLite. Metrics are computed off the hot path so token streaming stays unbuffered. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

### Why `aap run`?

`aap run` is **not required** — the proxy is transparent, so any client that points its
provider base URL at it will be captured. What `aap run` adds is **attribution**, because
that context only exists in the shell where the agent starts, not in the HTTP traffic:

- It generates a stable **session id** and injects it into the base URL path
  (`/<session_id>/<provider>/...`), so concurrent agents (e.g. several terminal tabs) are
  grouped correctly instead of being merged.
- It captures the **working directory and git repo** and registers them with the proxy.
- It points the agent at the proxy for this session — via base-URL env vars for Claude Code,
  or an injected `OPENCODE_CONFIG_CONTENT` for opencode — and execs the agent, inheriting your terminal.

Without it, requests still get captured but land in an **"unattributed"** session grouped
only by an idle-timeout window, with no cwd/repo. None of this metadata is ever sent to the
LLM — it is a side channel to the proxy.

## Stack

- Node + TypeScript
- Native `node:http`/`https` proxy, `better-sqlite3` index
- Config via TOML/YAML + env overrides

## Installation

Not published yet — install from source. Requires **Node 20+**.

```
git clone <repo-url> ai-agent-profiler && cd ai-agent-profiler
npm install          # install dependencies
npm run build        # compile to dist/
npm link             # put the `aap` command on your PATH (or: npm install -g .)
```

`npm link` is a per-machine step (each user runs it once after cloning); it symlinks the
`aap` CLI to this checkout. After pulling changes, re-run `npm run build`.

Then create your config where `aap` looks by default:

```
mkdir -p ~/.config/aap
cp config.example.toml ~/.config/aap/config.toml   # edit providers / pricing
```

`aap` resolves config in this order: `$AAP_CONFIG` → `~/.config/aap/config.toml` →
`./config.toml`, so it works from any project directory once the global config exists.

> Tip: set `storage.dir` to an absolute path (e.g. `~/.local/share/aap`) so captured data
> lives in one place regardless of where you start `aap serve`.

## Usage

```
aap serve            # start the proxy + read API (also prints a line per request)
aap run <agent>      # launch an agent through the profiler, e.g. aap run claude
                     #   tag a run: aap run --meta task=explain --meta iter=1 opencode
aap parse [--all]    # derive token/cost/tool metrics from captured traces
aap sessions         # list captured sessions (aap sessions rm <id> to delete)
aap commands         # break shell commands down by token cost (which to optimise)
aap export <id>      # export a session report (Markdown; add --json for JSON)
aap compare <ids>    # compare sessions side by side (add --json for JSON)
aap mcp              # start an MCP server (stdio) for agent self-introspection
aap config           # print the resolved configuration
```

Run `aap serve` in one terminal, then `aap run <agent>` from your project in another.
For development without linking, use `npm run dev -- <command>`.

Inspect captured data over HTTP (same port as the proxy):

```
GET /ui                        # web dashboard (also at /)
GET /stats                     # totals: sessions, requests, tokens, cost
GET /sessions                  # sessions with rolled-up metrics
GET /sessions/:id              # session detail with its requests
GET /requests/:id?events=1     # request detail + raw trace events
GET /health
```

Open **`http://localhost:8080/ui`** in a browser for the dashboard (sessions,
per-session requests, and per-request detail with the reconstructed response).

### opencode + DeepSeek

DeepSeek is OpenAI-compatible. Add it to your `aap` config:

```toml
[providers.deepseek]
upstream = "https://api.deepseek.com"
```

Then just launch opencode through the wrapper — no `opencode.json` edits needed:

```
aap serve                       # terminal 1
aap run opencode                # terminal 2, from your project
```

`aap run opencode` injects an `OPENCODE_CONFIG_CONTENT` that routes each configured
provider through the proxy (e.g. `http://127.0.0.1:8080/<session>/deepseek/v1`), which is
forwarded to `https://api.deepseek.com/v1/...`. opencode still supplies the API key itself
(from `~/.local/share/opencode/auth.json` or `DEEPSEEK_API_KEY`); the proxy only forwards
it and redacts it from stored traces. If a provider's base path isn't `/v1`, set
`apiPath` on its `[providers.<name>]` entry.

### Self-introspection via MCP

`aap mcp` starts a stdio MCP server so an agent can query its own captured behaviour —
"which requests cost the most?", "which file did I read most often?", "why so many `bash`
calls?". Tools: `list_sessions`, `get_session`, `get_request`, `search_requests`,
`recommend`, `compare`, `stats`, `top_tools`, `command_breakdown`, and `raw_sql` (read-only
SELECT over the SQLite index).

Add it to `opencode.json`:

```json
{
  "mcp": {
    "aap": { "type": "local", "command": ["aap", "mcp"], "enabled": true }
  }
}
```

## Benchmarks

`benchmarks/` contains a corpus of small, self-contained fixtures (each with a planted,
verifiable bug) and a runner that executes the same tasks through an agent, tagged for
profiling. Use it to measure — with real data — where an agent wastes tokens and tools.

```
aap serve
./benchmarks/run.sh opencode --fixture task-queue
aap sessions           # find the runs
aap commands           # which shell commands cost the most
```

See [`benchmarks/README.md`](benchmarks/README.md).

## Development

Requires Node 20+.

```
npm install
npm run dev -- <command>   # run the CLI via tsx, e.g. npm run dev -- sessions
npm test                   # vitest
npm run typecheck          # tsc --noEmit
npm run lint               # eslint
npm run format             # prettier --write
npm run build              # compile to dist/
```

The proxy is written with Node's native `http`/`https` for byte-faithful streaming; the
SQLite index uses `better-sqlite3`. Source is under `src/` (proxy, capture, store, parse,
recommend, api, ui, cli); the web dashboard is plain HTML/CSS/JS in `web/`.

## Documentation

- [`VISION.md`](VISION.md) — why the project exists.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is designed and why.
- [`ROADMAP.md`](ROADMAP.md) — what is done and what comes next.
- [`benchmarks/README.md`](benchmarks/README.md) — the benchmark corpus and runner.
- [`docs/aish-requirements.md`](docs/aish-requirements.md) — evidence-driven AISH capability skeleton.

## License

[MIT](LICENSE) © Raul Guiu
