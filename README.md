# AI Agent Profiler

A **local-first, read-only profiler for AI coding agents**.

It sits as a transparent proxy between a coding agent (Claude Code, Opencode) and an LLM provider (Anthropic, OpenAI-compatible), and records high-fidelity traces of every interaction so you can measure how the agent uses tools, files, context, and models.

It is a **performance profiler for autonomous coding agents** — not an observability dashboard, not an enterprise proxy, not an LLM profiler. See [`VISION.md`](VISION.md).

> Status: **early development** — building the capture core. See [`ROADMAP.md`](ROADMAP.md).

## Features (planned)

- Transparent, byte-faithful HTTP(S) proxy — never modifies requests.
- Per-session raw trace capture (requests, responses, streaming events, timing).
- Token, latency, and cost metrics derived from raw traces.
- Session explorer, search, and export.

## How it works

You launch your agent through a small wrapper that points its provider base URL at the profiler and tags the session:

```
aap run claude       # or: aap run opencode
```

The profiler streams traffic through untouched, tees a copy to append-only trace files, and indexes metadata in SQLite. Metrics are computed off the hot path so token streaming stays unbuffered. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

- Node + TypeScript
- Native `node:http`/`https` proxy, `better-sqlite3` index
- Config via TOML/YAML + env overrides

## Installation

_Not yet available — the project is in early development._

## Usage

Copy `config.example.toml` to `config.toml`, then:

```
aap serve            # start the proxy (also serves the read API)
aap run <agent>      # launch an agent through the profiler (e.g. aap run claude)
aap parse [--all]    # derive token/cost/tool metrics from captured traces
aap config           # print the resolved configuration
```

Inspect captured data over HTTP (same port as the proxy):

```
GET /stats                     # totals: sessions, requests, tokens, cost
GET /sessions                  # sessions with rolled-up metrics
GET /sessions/:id              # session detail with its requests
GET /requests/:id?events=1     # request detail + raw trace events
GET /health
```

## Documentation

- [`VISION.md`](VISION.md) — why the project exists.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is designed and why.
- [`ROADMAP.md`](ROADMAP.md) — what comes next.
