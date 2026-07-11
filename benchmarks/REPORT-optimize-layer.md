# Optimize Layer — Benchmark Report

**Status:** work in progress · **Last updated:** 2026-07-10
**Fixture:** `iterative-fix-plus` (7 modules, 9 planted bugs + 3 method stubs, 54 fixture
tests + hidden edge tests)
**Setups:** OpenCode → DeepSeek (`deepseek-v4-pro`) · Claude Code → Claude Opus (AWS Bedrock)

---

## TL;DR (read this first)

The optimize layer rewrites the requests an agent sends to the model, in flight, to cut
token waste. On the same task, the result was **opposite** on the two providers:

| Setup                   | Optimize vs baseline (cost)    | What happened                             |
| ----------------------- | ------------------------------ | ----------------------------------------- |
| **Claude / Bedrock**    | **−75%** (−93% in a 2nd batch) | Clear win, cache held, task quality best  |
| **OpenCode / DeepSeek** | **+491%**                      | Big regression, cache broke, agent looped |

The entire difference comes down to **one strategy, `pruneStale`**, interacting with
**one thing that differs between providers: the API format and how its prompt cache
reacts to editing old messages.**

- On **Claude** (Anthropic Messages format), `pruneStale` is the single biggest saver and
  is cache-safe → keep it **on**.
- On **DeepSeek** (OpenAI chat format), the same `pruneStale` shatters the prompt cache and
  makes things far more expensive → it should be **off** for OpenAI-format providers until
  we make it cache-preserving.

We proved this with a control run (`optimize-nps` = optimize with only `pruneStale`
disabled): turning that one strategy off flips DeepSeek from +491% to −7%, and shrinks the
Claude win from −75% to −17%.

**Honesty up front:** these are single-sample runs on one fixture. The _direction_ is
strong and reproducible; the exact percentages are noisy. We have a lot of captured data
we have not fully digested, and we do not yet claim to know the _best_ way to optimize —
only that provider-blind optimization is wrong. Details and caveats below.

---

## What the optimize layer is

An AI coding agent talks to a language model over HTTP. Because the model is **stateless**
(it remembers nothing between calls), the agent re-sends the _entire_ conversation history
on every turn — every file it read, every command output, every tool definition. That pile
grows every turn, and most of it is stale. That re-sent pile is where almost all the cost
is.

The profiler (`aap`) sits transparently between the agent and the provider. In read-only
mode it just measures the pile. With `--optimize` on, it rewrites each outgoing request to
trim the waste — without changing the model's replies or what the agent does next.

### The strategies

| Strategy           | What it does (plain)                                                                                                        | Why it saves                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pruneStale`       | Replaces tool results older than `pruneAfterTurns` with a 1-line summary (e.g. _"[read scheduler.js earlier — 47 lines]"_). | Old file reads the agent already acted on stop being re-sent in full. **The heavy hitter.** |
| `pruneUnusedTools` | After N turns, drops the definitions of tools the agent never called.                                                       | Stops mailing 27 unused tool specs every turn.                                              |
| `suppressReread`   | Skips a file read if the agent wrote that file <`suppressWithinTurns` turns ago.                                            | The agent already knows the content it just wrote.                                          |
| `dedup`            | Identical repeated tool call → keep the first result, stub the rest.                                                        | No paying twice for the same output.                                                        |
| `truncate`         | Results over `truncateThreshold` bytes → keep head + tail, drop the middle.                                                 | Caps giant blobs.                                                                           |
| `collapseSystem`   | Collapses a repeated, unchanged system prompt to a short hash stub.                                                         | The boilerplate prompt isn't re-sent in full each turn.                                     |
| `stablePrefix`     | Canonicalizes tool definitions so they're byte-identical every request.                                                     | Helps the provider's prompt cache actually hit.                                             |

All are on by default. Enable the layer with `aap serve --optimize` or `[optimize] enabled = true`.

---

## Why prompt caching is the hidden variable

Providers discount input tokens that repeat a recent **stable prefix** (prompt caching).
The discount is large and differs by provider:

| Provider              | Uncached input | Cached input | Ratio     |
| --------------------- | -------------- | ------------ | --------- |
| DeepSeek              | $0.435 /M      | $0.0036 /M   | **~121×** |
| Claude Opus (Bedrock) | $5.00 /M       | $0.50 /M     | **10×**   |

> _Pricing verified against anthropic.com/pricing on 12 Jul 2026, model Opus 4.x (Opus 4.8 here). Rates change — re-verify before quoting._

The catch: caching only applies while the prefix is **byte-stable**. Change something early
in the pile and everything after it is billed as new. This is exactly what `pruneStale`
does — it edits _old_ messages — so whether the cache tolerates that edit decides whether
`pruneStale` saves money or burns it.

---

## The two providers speak different formats

This is the mechanical root of the whole result. DeepSeek is **OpenAI-compatible**; Claude
uses **Anthropic's Messages format**. They represent a tool result — the thing `pruneStale`
rewrites — differently:

**OpenAI / DeepSeek** — a tool result is its own message with a plain **string** body:

```json
{
  "role": "tool",
  "tool_call_id": "call_42",
  "content": "<2 KB of scheduler.js as text>"
}
```

**Anthropic / Claude** — a tool result is a **block inside an array** on a user message:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_42",
      "content": "<2 KB of scheduler.js>"
    }
  ]
}
```

Same information, different container and position. And each provider's cache reacts
differently when `pruneStale` reaches back and mutates one of those old blocks.

---

## Results

### Claude / Bedrock (primary batch)

`aap compare --run baseline --run optimize --run optimize-nps`:

```
                 baseline      optimize      optimize-nps
──────────────────────────────────────────────────────────
Requests            26            22             29
Total input      1,118,303      209,903       941,647
  ↳ cached       1,110,403      203,923       935,524
  ↳ uncached         7,900        5,980         6,123
Cache hit rate       99%           97%            99%
Cost             $0.6210       $0.1568        $0.5177
Wall time        1049.0s        185.1s         234.5s
Fixture tests   FAILED(loop)    54/54          54/54
Edge tests         50/57         54/57          54/57
```

- Optimize: **−75% cost**, cache held at 97%, uncached tokens _down_, and it **passed all
  fixtures** — while the plain baseline actually **failed the task** (its scheduler fix
  contained an infinite loop that hung the tests).
- `pruneStale` fired **266×**, saving ~175K tokens, with only ~6K tokens re-billed uncached.
- A second batch corroborated the direction (baseline $2.38 → optimize $0.17, **−93%**).
  Baseline cost is the noisy term run-to-run; `optimize < optimize-nps < baseline` held in
  both batches.

### OpenCode / DeepSeek

> **⚠️ Superseded — this is the _provider-blind_ layer.** The +491% blow-up below is what
> happened when the Anthropic-tuned strategies (`pruneStale` et al.) ran unchanged against
> DeepSeek's OpenAI-format prefix cache. It is **not** the current behavior. A DeepSeek
> cache-safe profile (`profile = auto`) has since been built — it disables the prefix-editing
> strategies and adds cache-safe ones (`stableTruncate`, `frozenCompact`, `shapeTestOutput`).
> With it, DeepSeek runs hold a healthy 96–99% hit rate and show no cache resets. See
> [`docs/DEEPSEEK-FINDINGS.md`](../docs/DEEPSEEK-FINDINGS.md),
> [`docs/DEEPSEEK-CACHING.md`](../docs/DEEPSEEK-CACHING.md), and the current A/B in
> [`benchmarks/DEEPSEEK-COMPARISON.md`](DEEPSEEK-COMPARISON.md). The table below is retained
> as the evidence that motivated that work.

```
                 baseline      optimize      optimize-nps
──────────────────────────────────────────────────────────
Requests            49            117            22
Total input      2,188,710     6,946,916      920,640
  ↳ cached       2,151,168     6,528,000      879,744
  ↳ uncached        37,542       418,916        40,896
Cache hit rate       98%           94%            96%
Cost             $0.0461       $0.2725        $0.0428
Wall time         509.4s       1814.4s        657.0s
```

- Optimize: **+491% cost**, uncached tokens **+1016%** (37.5K → 418.9K — the expensive
  bucket exploded), and the agent **looped** (49 → 117 requests).
- Turning off only `pruneStale` (`optimize-nps`) flips it to **−7% cost** and 22 requests.

### The control isolates `pruneStale` in both directions

| Provider | optimize (pruneStale ON) | optimize-nps (pruneStale OFF)                          |
| -------- | ------------------------ | ------------------------------------------------------ |
| Claude   | **−75%**                 | −17% (win shrinks — pruneStale was load-bearing)       |
| DeepSeek | **+491%**                | −7% (regression disappears — pruneStale was the cause) |

Same strategy. Opposite sign. The only thing that changed is the provider format and its
cache behavior.

---

## What we think is happening

- **On Claude**, mutating an old `tool_result` block re-bills only the small uncached
  remainder — Anthropic's cache tolerates the edit. So `pruneStale` removes ~175K tokens of
  stale context per session and the cost drops. Cache-safe **and** the biggest saver.
- **On DeepSeek**, mutating the old `{role:"tool"}` string appears to invalidate the cached
  prefix from that point onward, so a large downstream chunk gets re-billed at the 121×
  rate. The savings are wiped out many times over.
- **Separately**, DeepSeek's agent started looping under pruning (2.4× the requests). We
  are **not certain** whether that's the model reacting poorly to summarized context or
  ordinary agent non-determinism. This is one of the undigested threads.

**What we can prove:** `pruneStale` is the cause (the control run), and DeepSeek's uncached
tokens explode while Claude's don't (the measurements). **What we can't yet fully explain:**
precisely why the two caches diverge (leading suspect: Anthropic's explicit cache
breakpoints vs DeepSeek's automatic prefix caching), and why the DeepSeek agent loops.

---

## Caveats — read before quoting numbers

- **Single samples, noisy.** One run each; agents are non-deterministic. Baseline cost
  swings a lot (Claude baseline: $2.38 vs $0.62 across two batches). Treat percentages as
  ballpark; trust the _direction_, not the decimals.
- **One fixture, two setups.** Not a broad survey. Other tasks/models/agents may differ.
- **No config aced the task.** Even winning Claude runs left **3/57 edge tests failing**
  (genuine agent bugs). The plain baseline often _failed outright_. "Baseline" is not a
  clean reference point — it was frequently the worst run.
- **Quality is independent of the cost story.** Edge scores were identical with `pruneStale`
  ON vs OFF (54/57), so pruning changed _cost_, not _correctness_. We are **not** claiming
  optimization made the model smarter from this data.
- **Corrected accounting matters.** An earlier DeepSeek report (now archived) showed a
  _win_ — that was a measurement bug (cached tokens mispriced for OpenAI-format providers).
  Fixing `compare.ts` to be format-aware reversed the DeepSeek conclusion. See
  [`archive/README.md`](archive/README.md).
- **Tooling honesty.** Two harness bugs meant the Bedrock test scores were gathered by hand;
  both are fixed now, but those numbers predate the fix.
- **Lots of undigested data.** We have full per-request traces we haven't fully analyzed.
  There is almost certainly more signal here than we've extracted.

---

## What this implies (and what's next)

1. **Gate strategies by provider.** `pruneStale` should stay ON for Anthropic-format
   traffic and be OFF (or made cache-preserving) for OpenAI-format / cheap-cache providers.
   That one rule turns DeepSeek's +491% into its −7% control result.
2. **Prune without breaking the prefix.** The DeepSeek damage came from _mutating_ early
   cached content. A smarter `pruneStale` could trim only from the uncached tail or align
   edits to cache boundaries — potentially safe on _both_ formats. **We haven't built or
   measured this yet.**
3. **Tune the dials per provider/task.** `pruneAfterTurns`, `truncateThreshold`, etc. are
   currently cautious fixed defaults. We suspect better values exist; we haven't searched.
4. **More samples, more fixtures, distributions not points.** The honest fix for the noise.

The earlier simple claim — "the optimize layer cuts cost ~70%" — is **true for Claude and
dangerously false for DeepSeek out of the box.** That nuance is only visible because we can
watch both conversations byte-for-byte and isolate a single strategy. We're still early in
learning how to optimize _well_; this report is a checkpoint, not a conclusion.

---

## Reproduce

```
# Claude/Bedrock or OpenCode/DeepSeek — baseline + optimize:
./benchmarks/iterative-fix-ab.sh <agent> --fixture iterative-fix-plus

# optimize-nps control (pruneStale off): copy config, set pruneStale = false, then:
AAP_CONFIG=/tmp/aap-nps.toml AAP_PORT=8299 aap serve --optimize &
AAP_CONFIG=/tmp/aap-nps.toml AAP_PORT=8299 ./benchmarks/run.sh <agent> --fixture iterative-fix-plus --tag optimize-nps

aap compare --run baseline --run optimize --run optimize-nps
```

Raw per-run data: [`archive/REPORT-iterative-fix-plus-bedrock.md`](archive/REPORT-iterative-fix-plus-bedrock.md)
and [`archive/REPORT-iterative-fix-plus-deepseek.md`](archive/REPORT-iterative-fix-plus-deepseek.md).
Historical context and superseded results: [`archive/README.md`](archive/README.md).
