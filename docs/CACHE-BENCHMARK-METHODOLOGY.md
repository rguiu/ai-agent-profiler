# Cache Benchmark Methodology

## How Anthropic/Bedrock Caching Works

### The Mechanism: Explicit Breakpoints + Byte-Prefix Matching

Anthropic's cache is NOT automatic. It requires **explicit opt-in** via `cache_control`
markers in the request body. Without these markers, no caching occurs at all.

```json
{
  "system": [
    {"type": "text", "text": "Short preamble"},
    {"type": "text", "text": "Main instructions...", "cache_control": {"type": "ephemeral"}},
    {"type": "text", "text": "More context...", "cache_control": {"type": "ephemeral"}}
  ],
  "tools": [...],
  "messages": [
    ...,
    {"role": "user", "content": [
      {"type": "tool_result", "content": "...", "cache_control": {"type": "ephemeral"}}
    ]}
  ]
}
```

Each `cache_control: {"type": "ephemeral"}` marks a **breakpoint**. The API caches
everything from the start of the request up to each breakpoint as a separate cache entry.

### How the Cache Key is Computed

The cache key is the **exact byte sequence** of the serialized request from position 0 up to
the breakpoint. This includes:

1. The `system` array (all blocks, in order, byte-for-byte)
2. The `tools` array (all tool definitions, in order, byte-for-byte)
3. The `messages` array (all messages up to the breakpoint, byte-for-byte)

**Any change to ANY byte before a breakpoint invalidates that cache entry.** This includes:

- Reordering tools or messages
- Adding/removing whitespace
- Changing a single character in a tool description
- Removing or adding a tool definition
- Modifying content of a past message (dedup stubs, truncation, etc.)

### How Cache Hits/Misses Work

On each request, the API walks the byte sequence from position 0:

```
Position:  0 ────────────────────────────────────── N
           [system][tools][msg1][resp1][msg2][resp2][msg3]
                     ↑                        ↑       ↑
                  breakpoint 1          breakpoint 2  breakpoint 3

Cache check:
  - Bytes 0..BP1 match prior request? → READ (BP1 tokens at $1.50/MTok)
  - Bytes 0..BP2 match prior request? → READ (BP2 tokens at $1.50/MTok)
  - Bytes BP2..BP3 are new?           → WRITE (new tokens at $18.75/MTok)
```

If bytes diverge at position X (before a breakpoint), everything from X onwards becomes a
cache MISS — either written (if a breakpoint covers it) or charged as regular input ($15/MTok).

### Where Claude Code Places Breakpoints

Claude Code places exactly 3 `cache_control: {"type": "ephemeral"}` markers:

1. **system[1]** — after a short preamble ("You are a Claude agent...")
2. **system[2]** — after the full system prompt (all instructions, CLAUDE.md, etc.)
3. **Last user message** — on the most recent tool_result block (the "trailing edge")

This means:

- System prompt + tools are cached after the first request
- The full conversation prefix (all past messages) is cached after each turn
- Only the new content (after the last breakpoint) is written each turn

### Pricing

| Token type    | Cost per MTok | When                                         |
| ------------- | ------------- | -------------------------------------------- |
| Cache read    | $1.50         | Bytes match a previously cached prefix       |
| Cache write   | $18.75        | New content up to a breakpoint (1.25× input) |
| Regular input | $15.00        | Content not covered by any breakpoint        |

Cache write is 12.5× more expensive than cache read. A cache miss that converts reads to
writes is devastating — converting 100K tokens from read to write costs an extra $1.73.

### Minimum Token Threshold

Caching only activates when the content up to a breakpoint exceeds **2048 tokens** (all models).
Smaller blocks are charged as regular input even with `cache_control` markers present. This is
why minimal test requests (short system + few tools) show 0% caching.

In practice, Claude Code's system prompt alone exceeds this threshold many times over.

### TTL (Time-to-Live)

Cache entries expire after a period of inactivity. Anthropic states "at least 5 minutes" for
ephemeral type. In practice, entries may persist longer under sustained usage. After expiry,
the next request pays the full cache-write cost again.

**Open question:** Exact TTL behavior is not publicly documented. The `cache-probe-bedrock.ts`
script in this directory can measure it empirically with `PROBE_TTL=1`.

## The Problem: Cross-Session Cache Warming

The cache key is the byte prefix, NOT the session ID. The cache persists across sessions —
if two requests from different sessions share the same byte prefix, the second one gets a
cache hit.

This means:

```
Session A (baseline):  [system + 9 tools + msg1]  → cache WRITE ($18.75/MTok)
Session B (baseline):  [system + 9 tools + msg1]  → cache READ ($1.50/MTok) ← free!
Session C (strip):     [system + 6 tools + msg1]  → cache WRITE ($18.75/MTok) ← different prefix
```

Session B gets cheap cache reads because Session A already paid the write cost for the same
prefix. Session C (with tools stripped) has a different prefix and starts cold.

## Impact on Benchmarks

### Baseline runs benefit from prior baselines

Our baseline runs all share the same prefix (system + 9 tools). After the first baseline run,
subsequent baselines get immediate cache hits on the stable prefix — **artificially reducing
their measured cost**.

```
baseline-1: true cold start → $6.13 (70 requests, lots of cache writes)
baseline-2: warm cache      → $2.67 (21 requests, mostly cache reads)
baseline-3: warm cache      → $2.41 (25 requests, mostly cache reads)
baseline-4: warm cache      → $3.82 (32 requests, mostly cache reads)
```

### Optimization runs start cold when the prefix changes

Any strategy that changes the byte prefix (including `stripTools`) produces a different cache
key. The first session with the new prefix pays the full cache-write cost. This inflates the
measured cost relative to the warm baselines.

```
strip-2 (cold): [system + 6 tools + msg1] → no prior cache → expensive first few requests
```

## Cache TTL and Session Resumption

### Leaving and coming back

If you leave for longer than the cache TTL:

- Your system prompt + tools prefix expires
- Your full conversation history prefix expires
- First request back pays cache-write on the ENTIRE context ($18.75/MTok on potentially
  200K+ tokens = $3.75+)
- Subsequent requests are cheap again (cache re-warmed)

### Session resume (`/resume` in Claude Code)

When you resume a killed session, the conversation history is restored client-side. But:

- If cache is still warm (within TTL): immediate cache hits, cheap
- If cache expired: first request pays full write cost on entire history

The session state is local. Cache state is server-side and time-dependent.

## Fair Benchmark Approaches

### Option 1: Cold vs Cold

Wait for cache TTL to expire between runs. Compare one cold baseline vs one cold strip.
Both pay the cache-write penalty on their first requests.

- Pro: Truly fair, no hidden advantage
- Con: Slow (must wait for TTL), high variance (single run each)

### Option 2: Warm vs Warm (steady-state comparison)

Run a warm-up session first (discard results), then run N benchmark sessions. Both groups
start with their respective prefixes warmed.

- Pro: Measures real-world steady-state performance (users run many sessions)
- Con: Warm-up run costs money; results only apply to users with sustained usage

### Option 3: Subtract cold-start penalty

Run N sessions. Discard or annotate the first session as "cold start". Compare sessions
2..N from each group.

- Pro: Practical with existing data
- Con: Assumes all variance in session 1 is from cold cache (it's partially model variance)

## The Math: Cold Start Penalty

For a prefix of P tokens, the cold-start penalty vs warm cache is:

```
penalty = P × ($18.75 - $1.50) / 1M = P × $17.25 / 1M
```

For our benchmark:

- Full prefix (9 tools): ~24K tokens → cold penalty ≈ $0.41
- Stripped prefix (6 tools): ~16K tokens → cold penalty ≈ $0.28

This penalty applies only to the first 1-2 requests. After that, the cache is warm for both.

## Cross-Session Optimization Opportunities

### Keep-alive pings

Send a minimal request periodically (e.g., every 4 minutes) to prevent cache expiry.
Cost: ~$0.001 per ping (just the output tokens for a minimal response).
Saves: ~$0.41 cold-start penalty if user returns after a break.

### Consistent tool sets

If all sessions use the same tool set, the system+tools prefix stays warm across sessions
automatically. `stripTools` changes the prefix — but once warm, the stripped prefix is
cheaper per-turn (fewer tokens read at $1.50/MTok).

### Morning cold start

First session of the day always pays the write cost (cache expired overnight). This is
unavoidable. Smaller prefix (fewer tools) means smaller write cost.

## Testing Cache Behavior

Run the probe script to empirically measure caching:

```bash
# Basic probe (tests cold/warm, cross-session, strip effect)
AAP_PORT=8080 npx tsx benchmarks/cache-probe-bedrock.ts

# With TTL measurement (slow — waits up to 10 minutes)
PROBE_TTL=1 AAP_PORT=8080 npx tsx benchmarks/cache-probe-bedrock.ts
```

Note: The probe requires `cache_control` breakpoints in the request to activate caching.
Without them, Bedrock charges everything as regular input ($15/MTok) with no caching at all.
