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
- First insights: tool usage, repeated tool calls (by argument), per-session context growth, and tool-result **token amplification** (how much each tool call added to context).
- Per-request logging in the `aap serve` terminal.

Planned:

- Web UI, search, and export.
- Analysis engine (repeated context/files, tool efficiency, recommendations).

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
aap parse [--all]    # derive token/cost/tool metrics from captured traces
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

## Documentation

- [`VISION.md`](VISION.md) — why the project exists.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is designed and why.
- [`ROADMAP.md`](ROADMAP.md) — what comes next.
