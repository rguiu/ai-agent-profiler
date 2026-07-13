# AI Agent Profiler

A **local-first profiler for AI coding agents** — read-only by default, with an
optional in-flight optimize layer (which, we found, mostly can't beat the provider's
own prompt cache — see [findings](docs/OPTIMIZATION-FINDINGS.md)).

It sits as a transparent proxy between a coding agent (Claude Code, opencode) and an
LLM provider (Anthropic, OpenAI-compatible) and records high-fidelity traces of every
interaction — so you can measure how the agent uses tools, files, context, and models.

It is a **performance profiler for autonomous coding agents** — not an observability
dashboard, not an enterprise proxy. See [`VISION.md`](VISION.md).

On top of profiling, there's an optional [optimize layer](#optimize-layer) that can
rewrite requests in-flight to cut token waste. We tried it and it mostly **doesn't beat
the provider's own prompt cache**: on both Anthropic/Bedrock and DeepSeek, the high-impact
ideas all edit the cached prefix, and editing the prefix costs more (cache writes / misses)
than the tokens it saves. So the layer is **off by default** and passes cached traffic
through. See [`docs/OPTIMIZATION-FINDINGS.md`](docs/OPTIMIZATION-FINDINGS.md) for the full
story, what remains safe, and future directions (e.g. rewriting only idle/cold sessions,
where the cache has expired anyway).

**Live demo:** explore real captured sessions in a static, read-only clone of the
dashboard — no install required: **https://rguiu.github.io/ai-agent-profiler/**
(sample data from two DeepSeek/opencode benchmark sessions; paths and credentials redacted).

## How it works

Launch your agent through a small wrapper that points its provider base URL at the
profiler:

```
aap serve            # terminal 1: proxy + read API
aap run claude       # terminal 2: launch an agent (or: aap run opencode)
```

The profiler streams traffic through untouched, tees a copy to append-only trace files,
and indexes metadata in SQLite. Metrics are computed off the hot path so token streaming
stays unbuffered. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

`aap run` is **not required** — the proxy is transparent, so any client pointed at it is
captured. What `aap run` adds is **attribution**: a stable session id, the working
directory + git repo, and per-session grouping for concurrent agents. Without it,
requests still land in an "unattributed" session. None of this metadata is ever sent to
the LLM.

## Features

- Transparent, byte-faithful HTTP(S) proxy — never modifies requests.
- Per-session raw trace capture (requests, responses, streaming, timing) with secret redaction.
- Token, latency, cost, and tool metrics derived from raw traces (`aap parse`).
- Read API + a dark-mode web dashboard at `/ui`.
- Insights: tool usage, repeated tool calls, context growth, tool-result **token
  amplification**, and **context composition** (system-prompt size, tool-definition
  tokens, duplicated totals).
- **Prompt-cache awareness** — captures provider cache-hit tokens so findings reflect real cost.
- **Message-stack breakdown** — per-request context split by role (system/user/assistant/tool).
- **Command-usage analysis** — which shell programs run through `bash`, how often, by category.
- **Recommendations** — actionable findings per session (repeated reads, redundant calls,
  high amplification, context duplication, inefficient search→read).
- **Export & compare** — session reports as Markdown/JSON; sessions side by side.
- **MCP server** (`aap mcp`) — 10 tools exposing the profiler's data for agent self-introspection.
- **Optimize layer** — 9 request-rewriting strategies, **off by default**; on cached providers it deliberately does very little (see below).

See [`ROADMAP.md`](ROADMAP.md) for what's next.

## Dashboard

![AI Agent Profiler dashboard](docs/dashboard.png)

![AI Agent Profiler session detail](docs/dashboard_session.png)

## Installation

Not published yet — install from source. Requires **Node 20+**.

```
git clone <repo-url> ai-agent-profiler && cd ai-agent-profiler
npm install          # install dependencies
npm run build        # compile to dist/
npm link             # put the `aap` command on your PATH (or: npm install -g .)
```

`npm link` is a per-machine step. After pulling changes, re-run `npm run build`.

Then create your config where `aap` looks by default. The easiest way is the
installer, which seeds `~/.aap/config.toml` (from your `config.toml`, or
`config.example.toml`) and points storage at `~/.aap/data`:

```
./install.sh
```

Or do it by hand:

```
mkdir -p ~/.aap
cp config.example.toml ~/.aap/config.toml   # edit providers / pricing / storage.dir
```

`aap` resolves config in this order: `$AAP_CONFIG` → `~/.aap/config.toml` →
`./config.toml`.

> Tip: set `storage.dir` to an absolute path (e.g. `~/.aap/data`) so captured
> data lives in one place regardless of where you start `aap serve`.

## Usage

```
aap serve            # start the proxy + read API (prints a line per request)
aap run <agent>      # launch an agent through the profiler, e.g. aap run claude
                     #   tag a run: aap run --meta task=explain --meta iter=1 opencode
aap parse [--all]    # derive token/cost/tool metrics from captured traces
aap sessions         # list captured sessions (aap sessions rm <id> to delete)
aap commands         # break shell commands down by token cost
aap tag <id> k=v     # tag a session with metadata (e.g. verify=pass)
aap export <id>      # export a session report (Markdown; add --json for JSON)
aap compare <ids>    # compare sessions side by side (add --json for JSON)
aap optimize <id>    # dry-run: show which optimizations would fire + tokens saved
aap mcp              # start an MCP server (stdio) for agent self-introspection
aap config           # print the resolved configuration
```

Inspect captured data over HTTP (same port as the proxy):

```
GET /ui                        # web dashboard (also at /)
GET /stats                     # totals: sessions, requests, tokens, cost
GET /sessions                  # sessions with rolled-up metrics
GET /sessions/:id              # session detail with its requests + analysis
GET /requests/:id?events=1     # request detail + raw trace events
GET /requests/:id/messages     # per-message context breakdown (roles, sizes)
GET /tools                     # global tool-usage totals
GET /commands                  # shell-command breakdown (?session=<id> to scope)
GET /health
```

Open **`http://localhost:8080/ui`** for the dashboard.

### opencode + DeepSeek

DeepSeek is OpenAI-compatible. Add it — plus a pricing table so cost can be
computed — to your `aap` config:

```toml
[providers.deepseek]
upstream = "https://api.deepseek.com"

# Per-million-token rates (check current prices). Cost is null without this.
[pricing."deepseek-chat"]
inputPerMTok = 0.435
outputPerMTok = 0.87
```

Then launch opencode through the wrapper — no `opencode.json` edits needed:

```
aap serve                       # terminal 1
aap run opencode                # terminal 2, from your project
```

`aap run opencode` injects an `OPENCODE_CONFIG_CONTENT` that routes each configured
provider through the proxy. opencode still supplies the API key itself; the proxy only
forwards it and redacts it from stored traces. If a provider's base path isn't `/v1`,
set `apiPath` on its `[providers.<name>]` entry.

**Token & cost capture.** OpenAI-compatible providers omit the `usage` block from
streaming responses unless the request opts in, which otherwise leaves token counts —
and therefore cost — unrecoverable. The proxy automatically injects
`stream_options.include_usage` on streaming chat-completions for OpenAI-format
providers (`openai`, `deepseek`), so usage is recorded on **every** request,
independent of `--optimize`. Pricing lookup is tolerant of a `provider/` prefix and
case, so a reported model like `deepseek/deepseek-chat` still resolves to the
`deepseek-chat` table above. If usage is genuinely absent, tokens and cost stay `null`
(never faked as `$0`) so a broken capture is visible.

### Ollama (local proxy)

Ollama's CLI talks to a daemon over its native API. Point the profiler's Ollama
upstream at your **local Ollama daemon** on `127.0.0.1` — not `ollama.com` — so the
daemon handles model routing and (for cloud models) authentication:

```toml
[providers.ollama]
upstream = "http://127.0.0.1:11434"
```

Then start the daemon and launch through the wrapper:

```
ollama serve                    # local daemon on 127.0.0.1:11434
aap serve                       # terminal 1
aap run ollama                  # terminal 2 — pins the active ollama session
```

`aap run ollama` sets `OLLAMA_HOST` to the proxy and marks the session as the active
Ollama session, so `/api/...` traffic is attributed to it. This works for both local
models and cloud models (`*:cloud`) — the daemon relays cloud requests to `ollama.com`
and authenticates via `~/.ollama/id_ed25519`. Pointing the upstream directly at
`https://ollama.com` returns **401** (the CLI sends no cloud credentials to what it
treats as a local daemon). See [Ollama specifics](#ollama-specifics) below for
attribution and parsing caveats.

### Providers & known issues

`aap` redirects each agent's provider base URL through the proxy. How that redirect
works — and its caveats — differ per provider:

| Provider      | Routing                                                                                      | Known issues                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic** | `ANTHROPIC_BASE_URL` → `/<session>/anthropic`                                                | —                                                                                                                                                                                 |
| **OpenAI**    | `OPENAI_BASE_URL` → `/<session>/openai`                                                      | —                                                                                                                                                                                 |
| **DeepSeek**  | opencode only, via `OPENCODE_CONFIG_CONTENT`                                                 | Not routed for non-opencode agents (no base-URL env). Base path is `/v1`; set `apiPath` if different.                                                                             |
| **Bedrock**   | Host-based `/model/...` (no session prefix); attributed to the active `meta.bedrock` session | Requires SigV4 re-signing, so AWS creds / `AWS_PROFILE` must be available to `aap serve`. Concurrent Bedrock sessions can mis-attribute (routing is host-based, not per-session). |
| **Ollama**    | Host-based `/api/...` (native API); attributed to the active `meta.ollama` session           | See below.                                                                                                                                                                        |

#### Ollama specifics

- `OLLAMA_HOST` accepts only scheme+host+port (no path), so requests can't carry a
  `/<session>/` prefix. They're matched by the `/api/` path and attributed to the
  session started by `aap run ollama` — concurrent Ollama sessions can mis-attribute.
- The daemon streams newline-delimited JSON labelled `application/json` (not
  `x-ndjson`); `aap` detects and parses it. Token usage comes from
  `prompt_eval_count`/`eval_count`; Ollama reports no cache tokens.

### Self-introspection via MCP

`aap mcp` starts a stdio MCP server so an agent can query its own captured behaviour —
"which requests cost the most?", "which file did I read most often?". Add it to
`opencode.json`:

```json
{
  "mcp": {
    "aap": { "type": "local", "command": ["aap", "mcp"], "enabled": true }
  }
}
```

## Optimize Layer

An optional layer that can rewrite request bodies in-flight. Enable it with `--optimize`
or in config:

```
aap serve --optimize
```

**It is off by default, and on cached providers it deliberately does very little.** We
built a range of prompt-shrinking strategies (summarising old results, dropping the
system prompt, pruning tools, compacting history) and found they don't beat the provider's
own prompt cache: on Anthropic/Bedrock and DeepSeek alike, the high-impact ideas edit the
_cached prefix_, and editing the prefix costs more (cache writes / misses) than the tokens
it saves. So the layer auto-detects the provider and keeps only the edits that don't touch
the cached prefix (`stripTools`, `tailTruncate`); everything that rewrites the middle of
the prompt is disabled in steady state.

**`optimizeOnCold` (on by default).** There is exactly one moment when editing the prefix
is free: after the cache has already expired. If the gap since the previous request exceeds
`cacheTtlMs` (default 30 min — deliberately conservative, since firing on a still-warm cache
would turn a cheap read into an expensive write), the next request pays a full cache-write
regardless — so for that single request the layer re-enables the full strategy set, shrinking
the prefix before it is written. Every subsequent read in the new TTL window is then cheaper.
It reverts to the safe set automatically on the next warm request. Watch the cache-regen
diagnostics to learn your real TTL, then lower `cacheTtlMs` accordingly.

**`upgradeCacheTtl` (off by default).** Claude Code always requests the **5-minute** cache
(verified across captured Bedrock traces: every `cache_control` marker is bare
`{"type":"ephemeral"}` with no `ttl`). Setting `upgradeCacheTtl = "1h"` rewrites those markers
to a 1-hour TTL before forwarding. On Opus 4.x a 1h write costs 2× input ($10/MTok) vs 1.25×
for 5m ($6.25/MTok), but the entry survives 12× longer — so it pays off when your idle gaps
often fall between 5 min and 1 hour (fewer re-writes), and it makes cross-user cache sharing
far more likely. Reads cost the same ($0.50/MTok) either way. Enable it from the start of a
session, since it changes the cached-prefix bytes.

The full story — what we tried, why it failed, what's still safe, and where real gains
might exist (e.g. cross-user prefix normalisation) — is in:

- [`docs/OPTIMIZATION-FINDINGS.md`](docs/OPTIMIZATION-FINDINGS.md) — the narrative.
- [`docs/OPTIMIZATION-STRATEGIES.md`](docs/OPTIMIZATION-STRATEGIES.md) — per-strategy catalogue + safety table.
- [`docs/CACHE-BENCHMARK-METHODOLOGY.md`](docs/CACHE-BENCHMARK-METHODOLOGY.md) — how the caches work and how to benchmark them fairly.
- [`docs/agents/anthropic.md`](docs/agents/anthropic.md), [`docs/agents/deepseek.md`](docs/agents/deepseek.md) — per-provider notes.

> **You don't need to pick strategies.** Pass `--optimize` and the auto-detected profile
> enables only the safe set for your provider.

### Inspecting what fired

A live optimized run records **which strategies fired** and how many tokens each removed,
per session:

```
aap export <session-id>            # Markdown report — "Optimizations applied" table
aap export <session-id> --json     # machine-readable: the `optimize` array
aap optimize <session-id>          # dry-run simulation over an already-captured session
```

(Recorded "tokens removed" is prompt shrinkage, not a guaranteed cost saving — see the
findings doc for why the two differ on cached providers.)

## Benchmarks

`benchmarks/` contains a corpus of small, self-contained fixtures (each with a planted,
verifiable bug) and a runner that executes the same tasks through an agent, tagged for
profiling.

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

The proxy uses Node's native `http`/`https` for byte-faithful streaming; the SQLite index
uses `better-sqlite3`. Source is under `src/` (proxy, capture, store, parse, recommend,
api, ui, cli); the web dashboard is plain HTML/CSS/JS in `web/`.

## Documentation

- [`VISION.md`](VISION.md) — why the project exists.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is designed and why.
- [`ROADMAP.md`](ROADMAP.md) — what is done and what comes next.
- [`docs/OPTIMIZATION-FINDINGS.md`](docs/OPTIMIZATION-FINDINGS.md) — what we tried to optimize, why it doesn't beat the cache, and where gains might still exist.
- [`docs/OPTIMIZATION-STRATEGIES.md`](docs/OPTIMIZATION-STRATEGIES.md) — per-strategy catalogue and cache-safety table.
- [`docs/CACHE-BENCHMARK-METHODOLOGY.md`](docs/CACHE-BENCHMARK-METHODOLOGY.md) — how the byte-prefix cache works, TTL, cross-session warming, fair benchmark methodology.
- [`docs/agents/anthropic.md`](docs/agents/anthropic.md), [`docs/agents/deepseek.md`](docs/agents/deepseek.md) — per-provider caching and optimizer notes.
- [`docs/OPTIMIZATIONS-TODO.md`](docs/OPTIMIZATIONS-TODO.md) — future optimization roadmap (normalizePrefix, optimizeOnCold, IASH).
- [`benchmarks/README.md`](benchmarks/README.md) — the benchmark corpus and runner.

## License

[MIT](LICENSE) © Raul Guiu
