# Request kinds

`aap parse` tags every request with a **kind** — what triggered it. Only a
fraction of an agent's API traffic is the user-driven turn; the rest are calls
the agent (or the CLI) makes on its own. Classifying them lets the dashboard
show _where the money actually goes_ and separate "cost I asked for" from
"overhead the tool spent on my behalf".

The kind is stored in `metrics.kind`, exposed by the `/kinds` API, and rendered
as a badge per request plus a **Cost by kind** table on the dashboard and each
session view.

## The kinds

| Kind       | Model      | Non-user? | What it is                                                                                                                               |
| ---------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `main`     | primary    | no        | The user-driven interactive loop — your actual turns.                                                                                    |
| `search`   | primary    | yes       | The read-only **file-search / `Explore` subagent** navigating the codebase. Usually the largest non-user bucket.                         |
| `guide`    | primary    | yes       | The **Claude guide agent** answering "how do I…"-style questions about Claude Code/SDK/API.                                              |
| `webfetch` | primary    | yes       | A subagent **summarising fetched web-page content** (WebFetch).                                                                          |
| `subagent` | primary    | yes       | A subagent we couldn't further identify (fallback).                                                                                      |
| `recap`    | primary    | yes       | A short **mid-session catch-up summary** ("The user stepped away…"), injected when you return to an idle session. Disable via `/config`. |
| `compact`  | primary    | yes       | **Context compaction** — full-history summarisation to shrink the context window.                                                        |
| `title`    | small/fast | yes       | **Session-title generation** (3–7 word summary), a one-shot Haiku call.                                                                  |
| `quota`    | —          | yes       | A quota / usage-limit check.                                                                                                             |
| `unknown`  | —          | —         | No system prompt or last message available to classify.                                                                                  |

"Non-user" calls are the ones worth watching: they cost real tokens but aren't
your prompts. `search` is typically the biggest and the most _tunable_ — its
volume is driven by how often exploration is delegated and how broad each brief
is ("very thorough over two repos" spawns a long agent loop).

## How detection works

Detection uses two signal sources, deliberately kept separate — see
`classifyRequestKind()` in [`src/parse/parse.ts`](../src/parse/parse.ts).

### 1. The top-level system prompt

Claude Code prepends an `x-anthropic-billing-header` system block to every call,
and subagents set `cc_is_subagent=true` there. The specialist's identity follows
in the same block:

```
x-anthropic-billing-header: cc_version=2.1.209.398; cc_entrypoint=cli; cc_is_subagent=true;
You are a Claude agent, built on Anthropic's Claude Agent SDK.
You are a file search specialist for Claude Code…      ← search
```

| Kind       | System-prompt marker                               |
| ---------- | -------------------------------------------------- |
| `search`   | `cc_is_subagent=true` + `file search specialist`   |
| `guide`    | `cc_is_subagent=true` + `Claude guide agent`       |
| `subagent` | `cc_is_subagent=true` (no known specialist marker) |
| `title`    | `Generate a concise… title` + `session`            |
| `quota`    | `quota` / `usage limit`                            |

### 2. The last message text

`recap` and `compact` run on the **main model with a normal system prompt** —
nothing in the system block distinguishes them from a user turn. They are only
identifiable by their **final instruction**:

| Kind       | Last-message marker                                         |
| ---------- | ----------------------------------------------------------- |
| `recap`    | `The user stepped away` + `recap`                           |
| `compact`  | `summary of the conversation` / `create a detailed summary` |
| `webfetch` | (subagent +) `Web page content:`                            |

## False-positive traps

Two subtle traps, both hit and fixed during development — respect them if you
extend the rules:

1. **Match the last message only, not the whole transcript.** A prior summary
   gets echoed back into later requests' context; matching anywhere in history
   would mislabel every subsequent normal turn as `compact`.

2. **Read text blocks only, not `tool_result` content.** `extractResultText`
   JSON-stringifies tool results, so captured command output that happens to
   mention "summary of the conversation" would leak in. `lastMessagePromptText`
   takes `type: "text"` blocks only, so tool output can't trigger a match.

Both effects are real: an earlier system-prompt-only classifier folded all
recaps into `main` and produced ~100 false `compact` hits; the current rules
reduce that to zero while catching the genuine recaps.

## Notes

- Classification is provider-agnostic in structure, but the markers above are
  Claude Code / Anthropic-specific. Other agents (opencode, ollama) fall through
  to `main`/`unknown`.
- Kinds are recomputed on every `aap parse` — re-run `aap parse --all` after
  changing the rules to backfill existing traces.
