# Cutting AI Coding Agent Costs by 72% — A Transparent Proxy Approach

**A deep dive into the AI Agent Profiler's optimize layer and what we learned from benchmarking Claude Code and OpenCode against the same bug-fixing task.**

---

## The problem: context grows faster than progress

AI coding agents (Claude Code, OpenCode, Cursor, etc.) work by sending the entire conversation history to the LLM on every turn. Each tool call — reading a file, running a test, searching the codebase — produces output that gets appended to the conversation. On the next request, all of it goes back to the model again.

This is expensive. Here's why:

1. **Input tokens dominate cost.** Most LLM APIs charge for input tokens, and in a long agent session, input dwarfs output. A 50-request session might send 2-3 million input tokens but only generate a few thousand output tokens. Input is where the money goes.

2. **Stale results pile up.** Early in a session, the agent reads files to understand the codebase. It then edits those files. Later requests still carry the *original* file contents in the conversation history, even though they've been superseded. The model pays to read stale data on every turn.

3. **Duplicated boilerplate.** System prompts and tool definitions are re-sent with every request. Many providers offer prompt caching, but the cache hit depends on byte-for-byte identical prefixes — any drift invalidates the cache.

4. **Redundant tool calls.** Agents often re-read files they just wrote, or make identical search calls across turns. Each one adds to the context without adding new information.

These problems compound: more context → slower inference → longer sessions → more accumulated waste. It's a feedback loop that makes long debugging or refactoring sessions disproportionately expensive.

## The approach: a transparent rewrite proxy

The AI Agent Profiler (`aap`) sits as an HTTP proxy between the agent and the LLM provider. In its default mode it's read-only — it captures traces for analysis without touching a single byte of the traffic.

But it also has an optional **optimize layer** that rewrites request bodies in-flight. It never modifies the LLM's response or the agent's behavior — it only changes what the agent *sends*, and only in ways that are semantically neutral (the agent can't tell the difference).

This is important: the optimize layer is not a middleware that intercepts tool calls or modifies the agent's workflow. It's a **request-body rewriter** that runs before each request hits the provider. The agent operates normally; the proxy just trims the fat from the outgoing payload.

### The strategies

Six strategies run on every request, ordered for correctness:

| Strategy | What it does |
|---|---|
| `stablePrefix` | Canonicalises tool definitions so the byte-prefix is identical across requests, maximizing prompt-cache hits |
| `dedup` | Detects identical repeated tool calls (e.g. re-reading the same file unchanged) and replaces the full result with a short stub |
| `suppressReread` | If a file was written within the last N turns, suppresses reads of that file — the agent already has the latest content |
| `pruneStale` | Replaces tool results older than N turns with a one-line summary (`[pruned: read foo.js (1.2KB), 6 turns ago]`) |
| `truncate` | For large results (>4KB), keeps the head and tail and drops the middle |
| `collapseSystem` | Replaces repeated system prompts with a hash stub after the first occurrence |

All strategies are configurable and can be toggled independently. The defaults are conservative — prune at 6 turns, suppress re-reads within 2 turns, truncate at 4KB.

## The experiment: fix 7 bugs with two agents

To measure the impact, we ran a controlled benchmark using the `iterative-fix` fixture: a small JavaScript project with 6 modules, 7 deliberately planted bugs, and 48 tests (8 failing). The task: fix all bugs until every test passes.

We ran the same task four times:

- **Claude Code** (Bedrock, eu-west-1): baseline and optimized
- **OpenCode** (DeepSeek v4 Pro): baseline and optimized

Each run used a fresh copy of the codebase, the same task prompt, and the same verification command (`node --test test/*.test.js`). Success is binary: all 48 tests must pass.

## Results

### Claude Code (Bedrock)

```
                   baseline  optimized      Δ
  ────────────────────────────────────────────
  Requests              48         52    +8%
  Total input      1,833,697    502,296   -73%
  Output tokens       1,748      3,204   +83%
  Cost               $2.88       $0.99   -66%
  Tool calls            32         41   +28%
  Wall time        1093.6s     818.6s   -25%
  Bugs found             7          9    +2
```

### OpenCode (DeepSeek v4 Pro)

```
                   baseline  optimized      Δ
  ────────────────────────────────────────────
  Requests              38         19   -50%
  Total input      2,878,660    820,652   -71%
  Output tokens      20,134      4,776   -76%
  Cost               $1.27       $0.36   -72%
  Tool calls            48         27   -44%
  Wall time         391.9s     280.0s   -29%
  Bugs found             7          8    +1
```

## What the numbers mean

### Cost (-66% to -72%)

The headline number. On Claude (Anthropic pricing), the optimize layer saved $1.89 per run — from $2.88 to $0.99. On OpenCode (DeepSeek pricing), it saved $0.91 — from $1.27 to $0.36.

The absolute savings are smaller on DeepSeek because the baseline cost is already low ($1.27 vs $2.88), but the *percentage* reduction is actually higher (72% vs 66%). The optimizer is more effective when there's more waste to eliminate.

For a team running 20-50 agent sessions per day, these savings compound. A single developer doing iterative bug-fixing across a workday could save $10-30/day on API costs alone.

### Total input (-71% to -73%)

This is the mechanism. The optimizer doesn't make the model smarter — it makes the context smaller. By pruning stale results and suppressing redundant reads, it removes information the model doesn't need and shouldn't be paying for.

The `pruneStale` strategy is the dominant contributor. In a 40-50 request session, results from turns 1-10 are still present in the context at turn 50. Replacing them with one-line summaries removes megabytes of stale text.

### Wall time (-25% to -29%)

Less data to transmit and process means faster round-trips. But the relationship isn't linear — the optimized Claude run had *more* requests (52 vs 48) yet still finished 25% faster, because each request carried 73% less input.

OpenCode's wall-time improvement (-29%) came from a different mechanism: the optimized run made *half* as many requests (19 vs 38). With cleaner context, the model could batch fixes more efficiently.

### Task quality (equal or better)

Critically, neither agent degraded. Both found all 7 planted bugs in all runs. The optimized runs actually found *more* issues:

- Claude optimized found 9 issues (+2: a `Date.now()` tie-breaking edge case in LRU eviction, and a scheduler starvation bug).
- OpenCode optimized found 8 issues (+1: a scheduler deadlock caused by a `break` in the scheduling loop).

The cleaner context didn't just save money — it gave the models more headroom to spot subtle edge cases that the noisier baseline context obscured.

### Why OpenCode made *fewer* requests when optimized

This is the most interesting behavioral difference. Claude's optimized run made *more* requests (52 vs 48) — it used the freed-up context capacity to do additional verification and find extra bugs. OpenCode's optimized run made *fewer* requests (19 vs 38) — it used the cleaner context to batch fixes more aggressively.

This suggests that optimization effects are agent-dependent. Claude (Anthropic's models) treats freed context as room for more thoroughness. DeepSeek (OpenCode's model) treats it as room for more efficiency. Both are valid — and both produce correct results.

## Where the savings actually come from

Let's trace a concrete example. In a typical fix-bug session:

1. **Turn 1-3:** The agent reads 4-6 source files to understand the codebase. Each file read returns ~1-2KB of content.
2. **Turn 4-8:** The agent edits files, runs tests, reads changed files to verify.
3. **Turn 9-12:** The agent finds more bugs, repeats the edit/test cycle.
4. **Turn 13-20:** Final fixes and verification.

Without optimization, every request from turn 7 onward carries the full content of all files read in turns 1-3 — files that have since been modified. That's ~6-12KB of stale content per file, re-sent in 10+ requests. The waste scales with session length.

With `pruneStale` (threshold: 6 turns), by turn 7 those early reads are replaced with one-line summaries. With `suppressReread`, if the agent writes `foo.js` in turn 8 and tries to read it in turn 9, the read is suppressed entirely. With `dedup`, if the agent runs the same `npm test` command 5 times, only the first result is kept in full — subsequent ones become stubs.

The cumulative effect: a 50-request session that would send 1.8M input tokens instead sends 500K. Same task, same success, 73% less context.

## Limitations and when it doesn't help

**Short sessions (<10 requests).** The optimizer kicks in after a few turns of history accumulate. For quick one-shot tasks (explain this file, fix this typo), there's almost nothing to prune. The overhead is negligible, but so is the benefit.

**Single-file projects.** If the codebase is one file, there's no "stale" content to prune — the agent re-reads the same file and the content actually changes. The dedup and truncate strategies still help, but the big wins from `pruneStale` don't materialize.

**Agents that don't re-read.** Some agents (or agent configurations) are frugal with file reads. If the agent reads each file once and never re-reads, `pruneStale` has less to work with. The benchmark fixtures deliberately include re-read-heavy patterns to stress-test the optimizer.

**Provider caching differences.** The `stablePrefix` strategy maximizes prompt-cache hits, but its effectiveness depends on the provider's cache implementation. Anthropic's cache is prefix-based; OpenAI's is different. The strategy helps in all cases but the magnitude varies.

## Should you use it?

If your team runs AI coding agents for non-trivial tasks (multi-file edits, debugging sessions, refactoring), the optimize layer will save real money with zero downside. It's transparent, configurable, and doesn't touch the agent's behavior — it just removes waste from the outbound requests.

Enable it with one flag:

```
aap serve --optimize
```

Or permanently in config:

```toml
[optimize]
enabled = true
```

The defaults are safe. You can tune the thresholds if you want, but you probably don't need to — the benchmark shows 66-72% cost reduction with zero task degradation at the stock settings.

## What's next

The optimize layer is one piece of the AI Agent Profiler. The larger goal is to give teams hard data about how their agents use tokens, tools, and context — so they can make informed decisions about tooling, model selection, and workflow design.

The profiler captures every request, every tool call, and every byte of context sent to the LLM. It surfaces recommendations (repeated file reads, redundant tool calls, context bloat) and lets you compare runs side by side. The optimize layer is the natural next step: diagnose the waste, then eliminate it automatically.

If you're curious, the project is open source at [github.com/rguiu/ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler). The full benchmark reports are in `benchmarks/`.
