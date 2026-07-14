# Claude Code — agent notes

How AAP interacts with Claude Code as an agent (separate from the Anthropic/Bedrock
provider — see [anthropic.md](anthropic.md) for API-level notes).

## Session storage

Claude Code stores each session as a JSONL file:

```
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

- `<cwd-slug>` is derived from the project directory (e.g. `-Users-...-ai-agent-profiler`).
- `<session-uuid>` is a UUID v4 generated at session start.
- One JSON object per line. Types: `user`, `assistant`, `permission-mode`,
  `attachment`, `system`, `mode`, `file-history-snapshot`, etc.

### Tree structure (not flat)

Events form a tree via `uuid` → `parentUuid` pointers — **not** a linear log.
Claude Code's rewind/edit/checkpoint feature creates abandoned side branches.
The real conversation is the path from the newest leaf back to the root.

Only `user` and `assistant` events carry an API `message` object.
A tool call spans an `assistant(tool_use)` event and a later `user(tool_result)`
event; these must stay paired during compaction.

### Token data in transcript

Some assistant events include `message.usage`:

```json
{
  "input_tokens": 12000,
  "output_tokens": 500,
  "cache_read_input_tokens": 11500,
  "cache_creation_input_tokens": 0
}
```

This is the **Clay-hosted Anthropic API** response format. Bedrock reports these
separately (`cacheReadInputTokens`, `cacheWriteInputTokens`) and is NOT present
in the JSONL — only available via the proxy's Bedrock response parsing.

### AAP read-only analysis

`aap analyze-claude <session-id>` reads the JSONL file, walks the UUID tree to
find the active path, reconstructs the message array, estimates token usage, and
reports what compaction would save. Read-only — never modifies the transcript.

## Available APIs

### Environment variables (set by `aap run`)

| Variable                     | Effect                                            |
| ---------------------------- | ------------------------------------------------- |
| `ANTHROPIC_BASE_URL`         | Routes Anthropic API calls through proxy          |
| `ANTHROPIC_BEDROCK_BASE_URL` | Routes Bedrock calls through proxy                |
| `CLAUDE_CODE_USE_BEDROCK`    | Tells Claude to use Bedrock instead of direct API |

Claude Code does not natively consume `AAP_*` variables — they're used by the
wrapper to manage the proxy connection.

### MCP (Model Context Protocol)

Claude Code supports MCP servers. AAP ships with an MCP server (`aap mcp`) that
exposes profiling data. No reverse channel — the proxy can't tell the agent
what to do via MCP.

### Control endpoint (AAP-internal)

`POST /_control/sessions` — the wrapper registers the session before launch.
`GET /_control/sessions/{id}/last-body` — exposes the last request body for
keep-alive replay. The agent never calls these directly.

### No VSCode API access

The CLI version of Claude Code has no plugin API. The VSCode extension has
extension APIs, but AAP operates outside VSCode.

## What's observable

| Signal                     | Source                                   | Usage                   |
| -------------------------- | ---------------------------------------- | ----------------------- |
| Process liveness           | `child_process.on("exit")` in wrapper    | Keep-alive stop signal  |
| Request volume             | Proxy trace capture                      | Dashboard metrics       |
| Cache hit/miss (Anthropic) | Response `usage.cache_read_input_tokens` | Parse phase             |
| Cache hit/miss (Bedrock)   | Response `cacheReadInputTokens`          | Parse phase, live proxy |
| Byte-level cache point     | `commonPrefixTokens(prev, current)`      | Live proxy log          |
| JSONL growth               | File size / line count                   | Compaction trigger      |

## What's controllable

| Action             | Mechanism                                                     | Status           |
| ------------------ | ------------------------------------------------------------- | ---------------- |
| 1h cache TTL       | `aap run --cache-1h` → proxy rewrites `cache_control` markers | Shipped          |
| Keep-alive pings   | `AAP_KEEP_ALIVE=1 aap run` → wrapper replays last request     | Shipped          |
| JSONL compaction   | `aap run --compact-jsonl` → wrapper modifies JSONL            | **Not built**    |
| Direct JSONL write | Modify `~/.claude/projects/<slug>/<uuid>.jsonl`               | **Not safe yet** |

## Open questions

See [docs/wrapper/OPEN-QUESTIONS.md](../wrapper/OPEN-QUESTIONS.md) for:

- Leaf-selection heuristics (which path is the "real" conversation?)
- Transcript format stability across Claude Code versions
- Tool pairing integrity (assistant(tool_use) ←→ user(tool_result))

## Differences from opencode

| Aspect               | Claude Code                              | opencode                                  |
| -------------------- | ---------------------------------------- | ----------------------------------------- |
| Storage              | JSONL tree in `~/.claude/projects/`      | Different format in `~/.config/opencode/` |
| Cache API            | Explicit breakpoints via `cache_control` | Automatic prefix cache (no markers)       |
| Rewind/Edit          | Yes — creates tree branches              | No                                        |
| Session resume       | Yes — loads existing JSONL               | Yes                                       |
| MCP                  | Supported                                | Supported                                 |
| Compaction           | `Compact` rewrites history client-side   | No built-in compaction                    |
| Keep-alive viability | Good (1h cache makes pings cheap)        | Good (automatic cache, no markers needed) |
