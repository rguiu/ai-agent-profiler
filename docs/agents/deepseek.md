# DeepSeek (prefix cache) — agent notes

How the profiler treats DeepSeek / OpenAI-compatible traffic, why prompt-editing
optimizations backfire on it, and what remains open.

> **Cache family:** `prefix` (automatic token-prefix cache).
> **Optimizer stance:** prefix-editing strategies are **disabled**; only content
> transforms that keep the byte-prefix stable are allowed. In practice the layer is
> off by default. See [`../OPTIMIZATION-FINDINGS.md`](../OPTIMIZATION-FINDINGS.md).

This document consolidates our earlier DeepSeek caching and findings notes.

---

## 1. How DeepSeek caching works

DeepSeek uses **automatic Context Caching on Disk**. The server caches the longest
common **token prefix** between consecutive requests — the client places no markers.
A cached prefix token is billed at roughly **1/10th** the price of an uncached ("miss")
token. There is no cache-write premium and no manual TTL control; the cache is
best-effort and server-managed.

Sources: DeepSeek API docs — [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/),
[pricing announcement](https://api-docs.deepseek.com/news/news0802/),
[chat completion API](https://api-docs.deepseek.com/api/create-chat-completion).

### Prefix match from token 0

The cache key is a continuous token-prefix match starting at position 0. The request is
flattened into one token sequence in this order:

```
system  →  tools / function definitions  →  messages[0..n]
```

So the system prompt and tool schema are the _first_ tokens, part of the same prefix as
the conversation. Only requests whose beginning is byte-identical to a previous request
reuse the cache; partial matches in the middle never hit on their own.

### 64-token storage units

Internally the cache is stored in **64-token units**; content shorter than 64 tokens is
not cached. Matching resolves down to the last complete 64-token unit that mirrors an
existing entry (DeepSeek does not publish the exact algorithm).

### What an edit costs

An edit does **not** wipe the cache _before_ it. The prefix up to the change (rounded
down to a 64-token boundary) still hits; everything from the change onward misses and
seeds a new cache path.

```
0 ──────────── identical ──────────────┊──── changed ────── end
└──────────── CACHE HIT ───────────────┘└──── CACHE MISS ───┘
                                        ↑
                                   edit point
```

The cost of an edit is set by **where** it lands, not how you make it: delete, blank, or
shorten a message and you break the cache at the same position. Reordering identical
content is also a miss (a different prefix). Even a changing timestamp near the top
forfeits the discount for the whole request.

---

## 2. Measured evidence

`benchmarks/cache-probe.ts` sends crafted requests to the live DeepSeek API and reads back
the real `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. It settles whether caching
is a strict token-prefix from position 0 or can cache identical blocks regardless of
position (deepseek-chat, 5 blocks of ~1.6K tokens, base prompt 8046 tokens):

| Test                            | prompt |  hit | miss | reading                                     |
| ------------------------------- | -----: | ---: | ---: | ------------------------------------------- |
| base, cold                      |   8046 |    0 | 8046 | first send is all miss                      |
| base, repeated                  |   8046 | 7936 |  110 | ~99% hit — prefix cache works               |
| append at tail                  |   9606 | 7936 | 1670 | full base prefix hits; only new tail misses |
| edit early message              |   8166 |    0 | 8166 | early edit → entire request misses          |
| remove middle block             |   6364 | 1536 | 4828 | hits up to the removal, rest misses         |
| reorder two blocks (same bytes) |   8046 | 1536 | 6510 | identical content, new order → miss         |

**Verdict: strict prefix-from-token-0.** Position is everything; reordering identical
content does not hit; removing or moving a block breaks the cache from that point on.
There is no position-independent block caching. (An earlier informal claim of that was a
measurement artifact of the agent's `messages…tools` JSON ordering plus a char/4 token
estimate — corrected.)

---

## 3. What this means for the optimizer

Because a cached token is already ~10× cheaper than a fresh one, **removing tokens from
the prompt rarely pays off**: deleting `R` tokens at position `P` saves the cheap cached
rate on `R`, but converts the `D` tokens after `P` from cheap hits to full-price misses.
Break-even needs roughly `R > 0.9 × D` — you must remove almost the entire tail to win.
So mid-history pruning, tool pruning, system collapsing, and reordering all tend to be
net-negative on DeepSeek.

The only prompt edits that are safe are ones that keep the byte-prefix identical and only
ever touch content at (or after) the tail — i.e. transform a tool result the first time it
appears and never rewrite earlier turns. See
[`../OPTIMIZATION-STRATEGIES.md`](../OPTIMIZATION-STRATEGIES.md) for the per-strategy
safety table.

The profiler encodes this by mapping DeepSeek/OpenAI to the `prefix` cache family
(`src/optimize/profiles.ts`), which disables the prefix-editing strategies.

---

## 4. Open questions

- **Cold vs warm cache.** We explored cold/warm-start effects on Claude (see
  [`anthropic.md`](anthropic.md)). The equivalent behaviour on DeepSeek — TTL, eviction
  timing, and whether a returning/idle session is worth a one-time prompt rewrite — is
  **not yet known** and remains to be measured.
- **Cost verification.** Cost figures produced before the cache-write accounting fix have
  not been recomputed for DeepSeek; treat any historical dollar figures in archived docs
  as unverified.
- **Batch validation.** Any future claim of a real improvement needs repeated runs (agent
behaviour is non-deterministic) with the cache warmed equally across arms.
</content>
