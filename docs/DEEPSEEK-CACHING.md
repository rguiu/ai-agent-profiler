# DeepSeek Context Caching — How It Works and How to Exploit It

DeepSeek's automatic **Context Caching on Disk** bills a cached prompt-prefix token
at roughly **1/10th** the price of an uncached ("miss") token. There is no cache-write
premium and no manual TTL control — the cache is best-effort and fully server-managed.

Because a proxy like this one controls the exact bytes on the wire, we can either
maximise or destroy the discount. This document explains the mechanism and the
concrete strategy for keeping the discount.

> Sources: DeepSeek API docs — [Context Caching](https://api-docs.deepseek.com/guides/kv_cache/),
> [pricing announcement](https://api-docs.deepseek.com/news/news0802/),
> [chat completion API](https://api-docs.deepseek.com/api/create-chat-completion).

---

## 1. The mechanism

### Prefix match from token 0

The cache key is a **continuous token-prefix match starting at position 0**. Only
requests whose beginning is byte-identical to a previous request reuse the cache.
Partial matches in the *middle* of the input never trigger a hit on their own.

The whole request is flattened into one token sequence in this order:

```
system  →  tools / function definitions  →  messages[0..n]
```

So the system prompt and the tool schema are the *first* tokens. They are part of the
same prefix as the conversation.

### 64-token storage units

Internally the cache is stored in **64-token units**; content shorter than 64 tokens is
not cached. Matching is not per-token — it resolves down to the last complete 64-token
unit that mirrors an existing entry. DeepSeek does not publish the exact hash/algorithm,
but for planning purposes:

- match starts at token 0
- stored/compared in 64-token chunks
- trailing tokens that don't fill a 64-token block are treated as a miss

### What an edit actually costs

Editing, deleting, or inserting a message does **not** wipe the cache before the edit.
The prefix up to the change (rounded down to a 64-token boundary) still hits; everything
from the change onward is a miss and becomes the seed for a *new* cache path.

```
0 ──────────── identical ──────────────┊──── changed ────── end
└──────────── CACHE HIT ───────────────┘└──── CACHE MISS ───┘
                                        ↑
                                   edit point
```

**The cost of an edit is therefore determined by *where* it lands, not *how* you make
it.** Deleting a message, blanking it, or shortening it all break the cache at the same
position and re-bill the same downstream tokens. The lever that matters is the *position*
of the earliest divergence, and *how often* it moves.

### Reordering does not help

Identical content in a different order is a different prefix. `Tool A, Tool B` and
`Tool B, Tool A` do not share a cached prefix. Even a changing timestamp near the top of
the system prompt forfeits the discount for the entire request.

### TTL / eviction

Best-effort LRU. Entries stay warm from minutes to (usually) hours, occasionally days.
Construction takes seconds. No guarantees, no premium, no manual control.

---

## 2. Reporting

DeepSeek returns cache accounting at the **root of the `usage` object** (not nested under
`prompt_tokens_details` like OpenAI):

```json
"usage": {
  "prompt_tokens": 12050,
  "prompt_cache_hit_tokens": 11008,
  "prompt_cache_miss_tokens": 1042,
  "completion_tokens": 420,
  "total_tokens": 12470
}
```

Invariant: `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`.

Per-request metric worth logging:

```
cache_hit_rate = prompt_cache_hit_tokens / prompt_tokens
```

The parser already reads `prompt_cache_hit_tokens` (see `src/parse/parse.ts:460`) and
`computeCost` already prices cached tokens separately via `cacheInputPerMTok`
(`src/parse/parse.ts:926`).

---

## 2b. Measured evidence (not just the docs)

`benchmarks/cache-probe.ts` sends crafted requests straight to the DeepSeek API and reads
back the real `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. It settles the one
question that governs every strategy: **is caching a strict token-prefix from position 0,
or can identical blocks cache regardless of position?** Result (deepseek-chat, 5 blocks of
~1.6K tokens each, base prompt = 8046 tokens):

| Test                              | prompt | hit  | miss | reading                                  |
| --------------------------------- | -----: | ---: | ---: | ---------------------------------------- |
| base, cold                        |   8046 |    0 | 8046 | first send is all miss                   |
| base, repeated                    |   8046 | 7936 |  110 | ~99% hit — prefix cache works            |
| **append at tail**                |   9606 | 7936 | 1670 | full base prefix hits; only new tail misses |
| **edit early message**            |   8166 |    0 | 8166 | early edit → **entire** request misses   |
| **remove middle block**           |   6364 | 1536 | 4828 | hits only up to the removal, rest misses |
| **reorder two blocks (same bytes)** | 8046 | 1536 | 6510 | identical content, new order → **miss**  |

**Verdict: strict prefix-from-token-0.** Position is everything. Reordering identical
content does *not* hit. Removing or moving a block breaks the cache from that point on.
There is **no** position-independent block caching — an earlier informal measurement that
suggested otherwise was an artifact of the agent's `messages…tools` JSON ordering plus a
char/4 token estimate, not real cache behaviour.

**Consequence for "just delete old blocks":** deleting `R` tokens at position `P` saves
`R × miss_price` but converts the `D` tokens after `P` from hit→miss, costing
`≈ 0.9 × D × miss_price` (since a hit is ~10× cheaper than a miss). Break-even requires
**R > ~0.9 × D** — you must delete almost everything downstream of the cut to come out
ahead. So mid-history pruning is a net loss unless it removes the vast majority of the
tail. The only cheap edits are at/near the **tail** (small `D`) or a **one-time early
compaction** while the session is still young (small `D`).

To re-run the ground-truth probe: `tsx benchmarks/cache-probe.ts` (uses the DeepSeek key
from opencode's `auth.json`).

---

## 3. Why our current optimizations backfire on DeepSeek

`src/optimize/layer.ts` was tuned for Anthropic, where explicit cache breakpoints and a
larger cache-write model make aggressive prompt rewriting cheap. On DeepSeek the same
edits land near token 0 and re-bill everything after them:

| Action (`layer.ts`)     | Where it edits            | DeepSeek effect                                  |
| ----------------------- | ------------------------- | ------------------------------------------------ |
| `collapseSystem`        | `system` (token 0)        | Whole request is a miss every turn               |
| `pruneUnusedTools`      | `tools` (before messages) | Invalidates the entire message history           |
| `stablePrefix` (re-run) | `tools`                   | Any change re-seeds the whole downstream cache   |
| `pruneStale`            | oldest messages           | Early edit point → most of the context misses    |
| `dedup` / `truncate` / `suppressReread` | a fresh tool result, tail | Cache-safe — only touches never-cached suffix    |

The trap: a rewrite "saves" 2K tokens by shrinking an old result, but flips 40K+
downstream tokens from hit-price to miss-price. Net cost goes **up**. Our current
`tokensSaved` metric doesn't model this, so the simulator reports savings while the bill
rises. (Fixing the simulator to price the cache is tracked separately.)

**This layer stays as-is for Claude.** The DeepSeek fix is provider-aware behaviour, not a
rewrite of the mechanism.

---

## 4. How to get the most out of it

### Golden rule

> Keep the front of the prompt byte-stable. Only ever append to the tail.

An append-only history is the ideal DeepSeek shape: each turn extends the previous prefix,
so the entire prior context hits and only the new turn is billed at miss price.

### Context-shrinking strategies, ranked

**Worst — sliding-window deletion.** Dropping the oldest messages shifts the whole prefix
every turn → a fresh full miss every request. This is effectively what `pruneStale` does.
Per the break-even in §2b, deleting content at position `P` only pays off if it removes
`> ~0.9 ×` the tokens that follow `P` — so mid-history deletion is almost always a loss.

**Better — periodic frozen summary.** Replace the head with one summary block, but
regenerate it *rarely*. Each regeneration is one deliberate miss; between regenerations
the summary is a stable prefix again.

**Best — tiered context**, each layer changing less often than the one below it:

```
SYSTEM            (never changes)
TOOLS             (never changes; canonicalise ONCE at session start)
REPO SUMMARY      (changes every few hundred turns)
CONVERSATION SUMMARY (changes every few dozen turns)
APPEND-ONLY LOG   (changes every request — the only churn)
```

One expensive cache reset per compaction cycle instead of gradual per-turn invalidation.

### Concrete rules for a DeepSeek-aware optimize layer

1. **Never edit `system` mid-session.** Disable `collapseSystem` for DeepSeek.
2. **Canonicalise `tools` once, then freeze the bytes.** Never reorder or prune tool defs
   after the first request. Disable `pruneUnusedTools` / per-turn `stablePrefix` re-runs.
3. **Replace age-based `pruneStale` with a position-independent transform.** The token
   saver must be a *pure function of the result content*, not of its turn/position — then
   the same tool result maps to the same bytes in every request and the prefix never moves.
   This is what `stableTruncate` does (see below).
4. **Keep tail-only rewrites** (`dedup`, `truncate`, `suppressReread`).
5. **Gate compaction on a cost model, not a token count.** Only compact when
   `miss_price × downstream_tokens_reset` is repaid by the tokens removed over the expected
   remaining turns.

### Implementation: how this ships

- **`profile` config** (`auto` | `default` | `cache-safe`). `auto` (default) applies
  `CACHE_SAFE_OVERRIDES` only to prefix-cache providers (currently `deepseek`); `cache-safe`
  forces it everywhere; `default` keeps the full Anthropic-tuned layer. Wired in
  `resolveOptimizeConfig` (`src/proxy/proxy.ts`), so Claude behaviour is untouched.
- **`CACHE_SAFE_OVERRIDES`** disables `collapseSystem`, `pruneUnusedTools`, `pruneStale`
  and enables **`stableTruncate`**.
- **`stableTruncate`** (`src/optimize/layer.ts`): in the request `messages` array — where
  OpenAI/DeepSeek agents like opencode re-send the full tool-result history every turn — it
  replaces any large `tool`/`tool_result` content with a deterministic head+tail truncation.
  The transform depends only on the content, is idempotent (skips already-truncated text via
  a marker), and records each distinct result once. Because the bytes are identical on every
  request, tokens shrink **without moving the cached prefix**.

> Why not the response path? In OpenAI/DeepSeek format the model's response only contains
> the assistant's `tool_calls`; the agent runs tools locally and appends results to the
> *next request*. So the only live hook that sees tool results is `rewriteRequestBody`.

- **`frozenCompact`** (`src/optimize/layer.ts`) — the one strategy that *removes* history, done
  the cache-correct way. Measured cost data shows the dominant DeepSeek spend in long sessions
  is **re-missing accumulated context** (in one 440-turn session, 96.6% of miss tokens were
  content that wasn't new that turn — cache evictions re-billed). Compaction attacks that
  surface: once the emitted context crosses `compactThreshold`, everything between the anchor
  (message 0) and a recent tail (`compactKeepTail`) is folded into ONE deterministic summary
  message. The summary bytes are then **frozen** — re-emitted identically every turn — so it
  causes only one prefix reset per compaction, not per turn. A hysteresis floor prevents
  re-firing until enough new content accrues. In a 120-turn simulation this cut summed emitted
  context ~53% with just 2 resets. This is the payoff the §2b break-even predicts: the reset is
  amortised over the many turns that follow, so it only wins in genuinely long sessions.

### Metrics the profiler should track

- `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, hit percentage
- effective input cost vs. estimated cost with no cache
- **prefix stability** — hash of the largest shared token prefix between consecutive
  requests. When this drops unexpectedly it pinpoints the exact turn an optimization (or
  the agent framework itself) edited the prefix — the biggest hidden cost source.

---

## 5. Cheat sheet

| Do                                       | Don't                                        |
| ---------------------------------------- | -------------------------------------------- |
| Append to the tail                       | Delete/rewrite old messages every turn       |
| Freeze system + tools for the session    | Collapse/hash the system prompt mid-session  |
| Summarise the head rarely, then freeze   | Re-summarise every few turns                 |
| Canonicalise tool order once             | Reorder or prune tools per request           |
| Rewrite a tool result on first send only | Edit a result that's already in the history  |
| Price edits by downstream miss tokens    | Count only the tokens you removed            |
</content>
</invoke>
