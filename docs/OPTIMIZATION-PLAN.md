# Optimization plan — cache-aware request rewriting

## Wave 2 — implementation priorities

Clean separation between wrapper and proxy. No communication needed:
- **Wrapper** (`aap run`): permanent conversation compaction via JSONL manipulation.
  Makes the history smaller. One-time operation.
- **Proxy** (`aap serve`): per-request cache-lifecycle management. Makes the cache
  last longer. Runs on every request.

### 1. Wrapper-level optimization: JSONL compaction

The wrapper compacts Claude's conversation history directly in
`~/.claude/projects/<hash>/<uuid>.jsonl`. Claude then owns the compacted
version and re-sends it every turn — no proxy rewriting needed.

**Implementation steps:**
1. `aap run` discovers Claude's session JSONL path (parse `~/.claude/projects/`,
   match by cwd or let Claude tell us via `--session-id`).
2. On each Claude request, the wrapper estimates accumulated tokens (read the
   JSONL, sum message sizes / 4).
3. When accumulated tokens > threshold (configurable, default 80K):
   - Compute compaction boundary: fold messages [1..N-keepTail] into a summary
   - Ensure tool message pairing is preserved (keep assistant+tool_calls+tools together)
   - Write compacted JSONL atomically (write to .tmp, rename)
   - Keep backup of original (.bak)
   - Log the action (tokens saved)
4. Strategies to apply during compaction:
   - `stableTruncate`: truncate large tool results deterministically
   - `shapeTestOutput`: strip passing-test spam from test output
   - `pruneStale`: replace old tool results with compact summaries
   - `collapseSystem`: replace repeated system prompts with hash stubs
   - `dedup`: replace identical repeated tool results with stubs
   - `pruneUnusedTools`: remove tool defs never called
   - `suppressReread`: remove reads of files just written
5. Edge cases:
   - Claude is mid-request when compaction fires → wait for request to complete
   - Claude Code version mismatch → detect format, bail with warning
   - Session already compacted by Claude Code's own Compact → skip or piggyback
   - File locked or unreadable → retry with backoff, then bail

**No proxy communication needed.** The wrapper tracks token estimates from the
JSONL directly. It doesn't need cache hit/miss metrics to decide when to compact
— the token threshold is enough.

### 2. Keep-alive: prevent cache expiry during idle

The proxy replays the last request with `max_tokens: 1` before the cache TTL
expires, keeping the prefix warm. Lives in the proxy because it needs the API
connection (upstream URL, auth headers).

**Implementation steps:**
1. Per-session state: store `lastRequestBytes`, `lastRequestPath`, `lastRequestModel`.
2. Session abandonment detection (see §3.1 for full signal list):
   - **Strongest signal:** `aap run` knows the agent's PID. `kill(pid, 0)` checks
     liveness. Agent exited → session definitively over → stop pings immediately.
   - **Shell trap:** `aap run` injects a trap EXIT that curl-calls
     `POST /_control/sessions/{id}/end` on agent exit.
   - Explicit opt-in: `aap run --keep-alive` or session metadata `{ keepAlive: true }`.
3. Ping timing: ping at `TTL * 0.8` intervals (4 min for 5m cache, 48 min for 1h).
4. Ping execution:
   - Replay `lastRequestBytes` with `stream: false, max_tokens: 1`
   - If response shows `cache_creation > 0`: cache was already dead → stop pinging
   - If response shows `cache_read > 0`: cache is alive → continue
5. Abandonment policy:
   - Agent PID died → stop immediately
   - No user request within N pings → stop (user abandoned session)
   - Cache write detected → stop immediately (burning money)

**Cost model** (see §3.2):
- 5m cache: ~12.5 pings to break even with one rebuild. Borderline.
- 1h cache: ~12 pings to break even. Much more viable.
- **Recommendation:** only enable keep-alive with `upgradeCacheTtl = "1h"`.

### 3. 1h cache for Claude (Anthropic/Bedrock)

Claude Code always requests the 5-minute cache (`cache_control: { type: "ephemeral" }`).
The proxy can rewrite markers to 1h before forwarding. A 1h write costs 2× input
($10/MTok on Opus 4.x vs $6.25 for 5m) but survives 12× longer, so it wins when
idle gaps often fall between 5 min and 1 hour.

**Implementation steps:**
1. Strategy already implemented in `src/optimize/layer.ts` (`upgradeCacheTtl`).
   Activated by `[optimize].upgradeCacheTtl = "1h"` in config.
2. Verify it actually works (§2.1): controlled test with 6-minute gap.
3. Measure the real TTL: does the 1h marker actually give 1 hour? Run probes
   with increasing idle gaps and record cache hit rate.
4. If verified, make it the default for Bedrock/Anthropic providers when
   `--optimize` is active. The cost difference (2× write vs 1.25×) is small
   per-session and the extended window benefits keep-alive and cross-user sharing.
5. Surface in dashboard: next to cache metrics, show "TTL: 5m / 1h" and the
   effective cache window.

### 4. Additional improvements

- **4.1 Cache-point metrics in the live proxy.** Wire `commonPrefixTokens()` into
  the hot path (§2.5). Store previous request bytes per session. On each new
  request, compute `cachePointTokens = commonPrefixTokens(prev, current)`.
  Log it: `[cache] session X: 85% hit, divergence at token 41000`. This gives
  us visibility into actual cache behavior without waiting for the parse phase.

- **4.2 Read-only JSONL analysis first.** Before implementing writes, build a
  tool that reads Claude's JSONL, reconstructs the full message array, and
  reports what compaction WOULD save. Run it against real sessions to validate
  the approach without risk. `aap analyze --claude-session <path>`.

- **4.3 Keep-alive as a standalone proxy mode.** Allow the proxy to run keep-alive
  pings even when `--optimize` is off. Keep-alive is pure cache-lifecycle management,
  not request rewriting. `aap serve --keep-alive` (without --optimize).

- **4.4 OpenCode JSONL support.** Discover and support OpenCode's conversation
  storage format alongside Claude's. OpenCode sessions are also visible in the
  proxy. The wrapper should auto-detect the agent type and use the right format.

- **4.5 Compaction on session resume.** When `aap run` starts and Claude Code
  resumes a previous session (JSONL exists with history), compact immediately
  if the accumulated tokens exceed threshold. The first request of a resumed
  session is always a cache write → compacting before it is free.

- **4.6 Dashboard: compaction history.** Show when the wrapper compacted a session,
  how many tokens were saved, and the before/after message count. Gives users
  visibility into what the wrapper is doing.

---

## The fundamental constraint

Claude Code and opencode rebuild every request from scratch each turn. They re-send the
**full, unmodified** conversation history — the model only returns the new assistant
message. The proxy's edits are one-directional; the client never learns we changed anything.

So on turn N+1, the client sends the pristine content again. If the proxy doesn't re-apply
the **exact same** edit, the emitted bytes diverge from what was cached → the cache
rebuilds from the divergence point. This is why `tailTruncate` (which only touches the
newest message) and `optimizeOnCold` (which reverts after one turn) both fail: the client
"undoes" the edit on the next turn and the proxy doesn't re-apply it.

**The reproducibility rule:** an edit only helps if the proxy reproduces it identically
on every subsequent turn.

## What actually works today

Only deterministic, content-addressed transforms survive the reproducibility rule:

| Strategy | Mechanism | Safety |
|----------|-----------|--------|
| `stableTruncate` | Pure function of content — same input → same output every turn | prefix-safe |
| `shapeTestOutput` | Pure function of content — same test log → same shaped bytes | prefix-safe |
| `stripTools` | Removes tool defs from turn 1, before the first cache write | prefix-safe |
| `upgradeCacheTtl` | Rewrites `cache_control` markers (5m→1h), no content changes | safe |
| `prefixProbe` | Diagnostic only, no rewrites | harmless |

These are all **always-on** strategies — they don't need cold-start gating because they're
safe to apply every turn. The cold start concept adds nothing for them.

## What was removed

| Strategy | Why removed |
|----------|-------------|
| `tailTruncate` | NOT prefix-safe. Touches only the newest message. Client re-sends full result next turn when it moves mid-history → cache rebuild. `stableTruncate` replaces it. |
| `frozenCompact` | Can break `assistant(tool_calls) → tool` message pairing (OpenAI API constraint). Inserts a `role:"user"` summary that orphans tool messages whose parent assistant was folded. |
| `optimizeOnCold` | Causes a double cache write. Shrinks the prefix on the cold turn, then reverts. Next turn the client sends the full pristine prefix → divergence from the shrunk cache → entire prefix rebuilds. Two writes, strictly worse than doing nothing. |

## Ideas for making cold-start optimizations viable

The core problem: **one-shot edits (cold turn only) can't be sustained because the
client keeps sending unmodified history.** Every idea below is a different angle on
solving the reproducibility problem.

### Idea A: Deterministic-only (what we have)

Only apply transforms that are deterministic and reproducible. These run every turn,
not just on cold starts. The advantage: no state to manage, no cold-start detection
needed. The limitation: the set of possible transforms is small (content hashing,
canonicalization, tool removal). You can't do semantic pruning or history summarization.

**Status:** implemented, active under cache-safe profile.

### Idea B: Stateful replay — remember and re-apply

The optimizer stores the transform it applied on the cold turn and re-plays it on
every subsequent turn. Example:

1. Cold turn N: proxy prunes old tool results (positions 10-15), stores which messages were pruned + their hashes
2. Turn N+1: client sends full history including the pruned results. Proxy finds them by hash (not position) and re-applies the same prune
3. Turn N+K: same re-application

**Challenges:**
- Claude Code's Compact rewrites history, changing message content and positions
- Hash-based matching is fragile — a slight content change (timestamp, memory update) breaks the match
- The state grows with the conversation and must handle edge cases (new tool calls at previously-pruned positions)
- If the client compacts the same region, the proxy's prune becomes redundant but the state must reconcile

**Viability:** Possible for purely content-addressed edits (same content → same transform),
but fragile for position-based edits. A prototype could store `Map<contentHash, transformedContent>`
and re-apply if the hash matches.

### Idea C: Detect client-side compaction and piggyback

When Claude Code's Compact fires, the client itself rewrites history. From that point on,
the client sends the **compacted** form every turn — no divergence. The proxy can
piggyback additional deterministic transforms on this event without causing a double write.

Detection: the prefix legitimately shrinks/diverge early without an idle gap (distinguishable
from a cache expiry).

**Challenges:**
- Detecting compaction vs. any other prefix change is non-trivial
- False positive → double write bug re-introduced
- The marginal savings are small (Compact already removes the bulk of history)
- The deterministic transforms we'd add are safe to run always anyway, so piggybacking adds nothing

**Viability:** Low. The upside is marginal and the detection is fragile. Documented in
`OPTIMIZATIONS-TODO.md` §9 as "optimizeOnCompaction."

### Idea D: Proxy-side compaction — compact history ourselves

Instead of waiting for the client to Compact, the proxy could detect when the context is
large and compact it proactively. The key difference from `frozenCompact`:

- Insert a **tool_calls-preserving** summary: instead of a bare `role:"user"` summary,
  keep the last assistant-with-tool_calls and its tool responses, then summarize older
  content. This satisfies the OpenAI API constraint.
- Use a deterministic summary (hash-based) so the bytes are stable across turns.
- Only compact once, freeze the boundary, and re-emit the same compacted form every turn.

**Challenges:**
- Must correctly handle tool message pairing for both OpenAI and Anthropic formats
- The summary content must be useful enough that the model doesn't lose context
- The threshold for compaction must be high enough that it fires rarely (amortizing
  the cache write over many turns)

**Viability:** This is essentially a fixed version of `frozenCompact`. Worth exploring
if long sessions (200+ turns) frequently exceed context limits. Needs careful tool
message pairing logic.

### Idea E: Upgrade cache lifetime — extend the window

Don't shrink the prompt — make the existing cache last longer. Two approaches:

1. **`upgradeCacheTtl`** (shipped, off by default): Rewrite Claude Code's 5m
   `cache_control` markers to 1h. Costs 2× input on write ($10/MTok on Opus 4.x)
   vs 1.25× for 5m, but the entry survives 12× longer. Wins when idle gaps often
   fall between 5 min and 1 hour, and widens the window for cross-user cache sharing.

2. **Keep-alive pings** (future): Proactively replay the last request (`max_tokens:1`)
   during idle to keep the cache alive. Only economically viable with the 1h cache
   (break-even ~12h idle vs ~56 min with 5m). Caveats: phantom API calls, billing
   "activity," breaks proxy transparency.

**Viability:** `upgradeCacheTtl` is the lowest-risk change with real upside. Keep-alive
pings need TTL measurement data first.

### Idea F: Prefix normalization — team-shared cache

Rewrite per-user paths to a canonical team-wide form before forwarding, and rewrite
responses back to real paths. Multiple developers on the same project share a single
cache entry instead of each paying for their own write.

**Viability:** High for teams. Requires shared proxy and path mapping config.
Designed in `OPTIMIZATIONS-TODO.md` §7.

### Idea G: IASH — prevent waste at the source

Intercept shell commands before execution and rewrite them to produce bounded output
(e.g., append `| head -100` to `find`, return line count for `cat`). This reduces
what enters the context in the first place rather than editing it afterward.

**Viability:** High ROI. Doesn't involve cache mechanics — it prevents tokens from
being generated. Designed in `OPTIMIZATIONS-TODO.md` §1.

### Idea H: Client-state manipulation — write into Claude's own storage

Instead of rewriting every API request mid-flight and fighting the client's pristine
history every turn, **write the optimized/compacted history directly into Claude Code's
local conversation storage.** Claude then "owns" the optimized version and re-sends it
as the source of truth — the proxy does nothing on subsequent turns.

**Claude Code's storage format** (discovered on this system):
```
~/.claude/projects/<path-hash>/<session-uuid>.jsonl
```
Each line is a JSON event with `type`, `message`, `uuid`, `timestamp`:
```json
{"type":"user","message":{"role":"user","content":"..."},"uuid":"...","sessionId":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{...tool_use...}]},"uuid":"..."}
```

**How it would work:**
1. Proxy monitors the session. When context exceeds threshold, proxy reads Claude's
   JSONL file to understand the full conversation state.
2. Proxy compacts old entries (prune tool results, summarize assistant turns) and
   writes a NEW compacted JSONL file, replacing the original (with backup).
3. Claude Code reads the compacted file on next load. From then on, Claude re-sends
   the compacted history every turn.
4. The cache rebuilds once (the write from old→new prefix), then stays stable because
   Claude IS sending the compacted version.

**Advantages over request rewriting:**
- No per-request rewriting overhead (JSON parse + stringify on every turn).
- The prefix is genuinely stable — Claude owns the compacted history, no fight.
- Works on ALL providers (no OpenAPI tool-message pairing bug, no Anthropic breakpoint
  issues). The proxy just observes.
- Survives proxy restarts (the compaction is persisted in Claude's storage).
- Compatible with Claude Code's own Compact — the proxy can wait for Compact to fire
  naturally, then piggyback additional pruning on the already-rewritten file.

**Risks and unknowns:**
- **Format stability.** The JSONL format is undocumented and could change between
  Claude Code versions. Needs version detection and graceful fallback.
- **File locking / concurrent access.** Claude Code may hold the file open or write
  to it between proxy reads. Need atomic replace (write to temp file, rename).
- **UUID / session linkage.** The session UUID in the JSONL must match what the proxy
  tracks. The proxy knows the session ID from the request path (`/<session-id>/...`).
  Mapping Claude's JSONL UUID to the AAP session ID requires either (a) matching by
  timing/content, (b) the `aap run` launcher passing the mapping, or (c) searching
  for matching content in recent JSONL files.
- **Corruption risk.** If the proxy writes a malformed JSONL file, Claude Code may
  fail to load the session. Must keep a backup and validate.
- **Agent support.** OpenCode likely uses a different storage format. Need to discover
  and support each agent separately.
- **Ethical boundary.** Modifying another program's local state files is invasive.
  Must be opt-in, clearly documented, and never enabled by default.

**Implementation sketch:**
```
On session registration (aap run):
  1. Wrapper discovers Claude's project-hash and session UUID
     (parse ~/.claude/projects/, find matching cwd, or launch Claude with
     --session-id so we know the UUID in advance)
  2. Wrapper registers with proxy: POST /_control/sessions
     { id, cwd, meta: { claudeProjectHash, claudeSessionUuid, claudeJsonlPath } }
  3. Proxy stores the mapping

On context threshold exceeded (proxy detects via token estimation):
  1. Proxy evaluates: is the cache warm? Would compaction save enough
     to justify the one-time cache rebuild?
  2. If yes, proxy signals the wrapper: POST /_control/sessions/{id}/compact
     { boundary: index, summary: "...", strategy: "frozenCompact" }
  3. Wrapper receives signal:
     a. Lock: verify Claude isn't actively writing (check file mtime)
     b. Read: parse JSONL, reconstruct full message array
     c. Compact: apply the specified transform (proxy computed the boundary)
     d. Write: serialize to .jsonl.tmp, validate parseable
     e. Backup: copy original to .jsonl.bak
     f. Atomic replace: rename .jsonl.tmp → .jsonl
     g. Acknowledge: POST /_control/sessions/{id}/compact-done { ok: true }
  4. On next Claude Code request:
     Claude reads the compacted JSONL, sends compacted history.
     Proxy observes — no rewriting needed. Cache write is a one-time cost.
     Subsequent turns: prefix stable, cache reads cheap.
```

**Why the wrapper, not the proxy:**
- **Filesystem scope.** The proxy may run on a different machine (team proxy setup).
  The wrapper always runs alongside Claude on the developer's machine.
- **Version compatibility.** The wrapper is tied to a specific `aap` version that
  ships with the agent launcher. It can evolve format support in lockstep with
  Claude Code updates.
- **Failure isolation.** If the wrapper corrupts the JSONL, the proxy keeps
  functioning. The wrapper can detect the corruption on next launch and restore
  from backup. If the proxy corrupts it, the user gets a broken session with
  no obvious cause.
- **Separation of concerns.** Proxy = observe + decide. Wrapper = execute + manage
  agent lifecycle. This is already the pattern for session registration via
  `/_control/sessions`.
- **Bidirectional protocol.** The control endpoint already exists (§3.4). Adding
  `compact` and `compact-done` routes extends an established channel.

**What the proxy computes and sends to the wrapper:**
```json
POST /_control/sessions/{id}/compact
{
  "boundary": 180,              // messages before this index get folded
  "foldedTokens": 45000,        // tokens being compacted
  "summaryTokens": 200,         // tokens in the replacement summary
  "netSavings": 44800,          // tokens saved per turn after compaction
  "summary": "[earlier conversation...]",  // text to insert
  "strategy": "frozenCompact"   // which transform to apply
}
```
The wrapper doesn't need to understand optimization logic — it just executes the
file rewrite with the proxy's computed parameters.

### Resurrecting failed strategies via JSONL manipulation

The strategies we removed (§"What was removed") all failed for the same reason:
the client re-sends pristine history next turn, undoing the proxy's one-shot edit.
When the wrapper writes the optimized history directly into Claude's JSONL file,
**that reason disappears.** Claude owns the optimized version and re-sends it
identically every turn.

| Strategy | Why it failed before | Why it works via JSONL |
|----------|---------------------|----------------------|
| `tailTruncate` | Only touched newest message; client re-sent full result next turn when it moved mid-history | Write the truncated version into JSONL. Claude sends truncated version every turn from then on |
| `pruneStale` | Age-based pruning produced different output every turn (message "age" changes) → non-deterministic → cache rebuild | Prune ONCE at compaction time, write result. Every subsequent turn sends identical bytes |
| `collapseSystem` | Replaced system prompt with hash stub; next turn client sent full prompt → divergence at byte 0 | Collapse the system prompt in JSONL. Claude sends the stub every turn |
| `pruneUnusedTools` | Removed tool defs mid-session; same defs reappeared next request from client | Remove from JSONL. Claude builds requests without those tools from then on |
| `frozenCompact` | Inserted `{role:"user"}` summary that broke OpenAI tool message pairing | Write the compacted conversation into JSONL. Claude rebuilds API request correctly (assistant+tool_calls stay together) |
| `dedup` | Identical tool results were only detected per-request; varied across turns | Dedup IN the JSONL. Duplicate results are replaced with stubs permanently |
| `suppressReread` | Write-then-Read pattern only detectable per-request | Prune the redundant Read from JSONL history entirely |
| `reorderVolatile` | Moved `<system-reminder>` blocks; client re-sent original ordering next turn | Reorder IN the JSONL. Claude sends the reordered version every turn |

The entire proxy-side `OptimizeLayer` becomes optional. The compaction is a
scheduled, batch operation on the JSONL file — not a per-request hot-path
transform. The proxy only needs to:
1. Estimate token usage from the request body (for threshold detection).
2. Compute the optimal compaction boundary and summary.
3. Signal the wrapper with the parameters.

All the complex message-rewriting logic (`mapToolResults`, `headTailTruncate`,
`pruneStaleResults`, `frozenCompactMessages`, etc.) moves from the proxy's
request handler into a compaction utility that the wrapper calls on the JSONL.

**New question: when to compact?**
- **On cache expiry** (what `optimizeOnCold` attempted): idle gap > TTL. The
  next request pays a full cache write regardless, so compact before it to
  shrink what gets written. Unlike the old approach, the compacted form
  PERSISTS in JSONL → no double write.
- **On context threshold exceeded**: emitted tokens > N (e.g., 80K). Compact
  proactively to keep the conversation manageable.
- **Piggyback on Claude Code's own Compact**: detect the client-side compaction
  event (prefix shrinks without idle gap), then apply additional transforms
  on top. This is the `optimizeOnCompaction` idea, now viable because the
  wrapper can read the post-Compact JSONL and apply extra pruning.
- **On session resume**: when `aap run` starts and detects a previous session's
  JSONL still exists (Claude Code resumes conversations), compact if the
  history has grown stale.

**Viability:** High potential, high risk. This is the only approach that genuinely
solves the cache coherence problem. If the format is stable enough and the
corruption risk can be managed, it could replace the entire request-rewriting
layer. Start with a read-only analysis (parse Claude's JSONL, measure what
compaction WOULD save) before attempting writes.

## Priority

1. **`upgradeCacheTtl`** — lowest risk, real upside. Collect data on idle gaps to
   confirm the 5m→1h upgrade pays off. Enable by default if data supports it.

2. **Client-state manipulation (Idea H)** — highest potential, medium risk. Read
   Claude's JSONL to understand what compaction would save. If the format is stable,
   this could replace the entire request-rewriting layer. Start with read-only analysis.

3. **IASH** — prevents waste at the source. No cache considerations. High ROI.

3. **Prefix normalization** — team-level savings. Requires shared proxy deployment.

4. **Proxy-side compaction (Idea D)** — if long sessions are common and
   context-limit errors are a problem. Fixes `frozenCompact`'s tool pairing bug
   and makes it a viable strategy.

5. **Stateful replay (Idea B)** — most ambitious but most fragile. Only worth
   exploring if the deterministic set proves insufficient and real traces show
   large savings from semantic pruning.

## What NOT to pursue

- **`optimizeOnCold`** — broken by design (double write). The reproducibility rule makes
  one-shot cold rewrites inherently harmful, not just difficult. Even if you could
  detect the cold turn perfectly, the next turn undoes the work.

- **Position-based editing** (`tailTruncate`, `pruneStale` on cached providers) — any
  edit that treats "position in history" as the key fails when the client re-orders
  or compacts the conversation.

## Next steps

### 1. Better observability

Before building more optimizations, we need to see what's actually happening.
Currently the proxy logs cache hit/miss only for Bedrock (via on-demand API call
to get `cacheReadInputTokens`), and DeepSeek has no cache observability at all.

- **1.1 Per-request cache metrics on captured traces.** Parse `usage.cache_read_input_tokens`,
  `cache_creation_input_tokens` from OpenAI-format responses. DeepSeek exposes these
  (unlike Anthropic's opaque response). Log the ratio per request: what fraction of
  input tokens came from cache vs writting new cache lines. Surface in the dashboard
  as a cache-efficiency score.
- **1.2 Cache-churn dashboard widget.** Per session: plot cache hit rate over time.
  Flag turns where the hit rate drops (prefix edited by client or proxy). Overlay
  with optimize actions to see if a strategy caused a cache rebuild.
- **1.3 Prefix-diff logging.** When `prefixProbe` detects a prefix break, log the
  diff range (which byte position diverged) and the suspected cause (system prompt
  change, tool def reorder, message edited mid-history, client compaction).
- **1.4 Real TTL measurement.** DeepSeek and Anthropic don't publish exact cache TTLs.
  Run controlled experiments: send identical requests with increasing idle gaps, record
  cache hit rate vs. idle time, fit a decay curve. This tells us the real window for
  keep-alive pings and `upgradeCacheTtl`.
- **1.5 Idle-gap distribution across real sessions.** Parse the timestamp gaps between
  requests in captured sessions. Bucket gaps into: sub-5m, 5m-1h, 1h+. This tells us
  how often cache expiry actually happens and whether `upgradeCacheTtl` would help.

### 2. Try theories

Testable hypotheses about cache mechanics on real providers.

- **2.1 Verify `upgradeCacheTtl` actually works on Claude.**
  - Send two identical requests through Claude Code, 6 minutes apart.
  - With `upgradeCacheTtl = "off"` (5m passthrough): expect the 2nd request to
    rebuild the cache (cache_creation > 0).
  - With `upgradeCacheTtl = "1h"`: expect the 2nd request to hit the cache
    (cache_read > 0, cache_creation = 0).
  - Measure via Bedrock's `usage` field or the `x-amzn-bedrock-cache-*` response headers.
  - **Risk:** Claude Code might place `cache_control` markers that the backend ignores
    or TTL-upgrades. Need to verify the 1h TTL is honored, not just sent.
- **2.2 Measure the exact cost of prefix edits on DeepSeek.**
  - Baseline: 10-turn append-only session, measure cache-hit rate and cost.
  - With `stableTruncate` enabled: same session, same tool output. Expect identical
    hit rate (deterministic transform). Confirm cost is lower.
  - With a prefix edit (system prompt change mid-session): measure the cache-miss
    cascade and compute the actual cost penalty. This gives us a concrete number for
    "editing the prefix costs X."
- **2.3 Does DeepSeek cache survive Claude Code's Compact?**
  - Claude Code rewrites its own history on Compact. Does DeepSeek's token-prefix
    cache recognize the rewritten prefix as a continuation of the old cache?
  - If yes: cache survives compaction, great. If no: compaction triggers a full
    rebuild — that's a spot where proxy-side compaction (Idea D) could be better.
- **2.4 Content-addressed truncation durability.**
  - `stableTruncate` is deterministic — same content → same output. Verify this
    holds across turns by comparing the actual bytes sent to the API. A single byte
    difference means a cache miss.
- **2.5 Cache-point awareness — not all cache is destroyed on edit.**
  - Prefix caches (DeepSeek) and breakpoint caches (Anthropic) are NOT all-or-nothing.
    Only bytes AFTER the divergence point are re-billed. Bytes before the first
    difference remain cache hits.
  - The proxy already has `commonPrefixTokens()` in `src/optimize/cache-cost.ts`
    that computes the token-aligned common prefix between any two request bodies.
    It is used by the simulator but NOT wired into the live proxy hot path.
  - **Wire it into the live proxy:** store the previous request's raw bytes per
    session. On each new request, compute the cache point:
    ```
    cachePointTokens = commonPrefixTokens(prevBody, currentBody)
    cacheHitBytes ≈ cachePointTokens * 4
    cacheMissBytes ≈ totalBytes - cacheHitBytes
    ```
    Surface this as a per-request metric: "85% cache hit, divergence at byte 82,000."
  - **Use it to guide edits:** if the cache point is at byte 82K and the total request
    is 100K, we have 18K of "free edit zone" — any transform that only touches bytes
    after 82K costs nothing (those bytes are already a cache write). Edits before
    82K would re-bill from the edit point.
  - **Combine with keep-alive:** if the cache point is early (byte 5K), the cache is
    almost entirely hot — better to keep it alive than compact. If the cache point
    is late (byte 95K), the cache is mostly cold — might as well compact now.
  - **For Anthropic/Bedrock:** the response already tells us `cache_read_input_tokens`
    and `cache_creation_input_tokens`. The cache point is approximately at
    `cache_read_input_tokens` in the token stream. We already parse this in
    `src/parse/parse.ts:277-279` and store it in SQLite. But the LIVE proxy doesn't
    read these metrics from the response stream — they're only available in the
    parse phase (background, off-hot-path). To use it for live decisions, the
    proxy would need to parse the response body or extract them from SSE chunks
    as they stream through.
  - **For DeepSeek/OpenAI:** the response includes `usage.prompt_tokens_details.cached_tokens`
    (parsed in `parse.ts:471` if present). But DeepSeek may not consistently expose
    this field. The `commonPrefixTokens` byte-comparison approach works regardless
    and gives a precise byte-level cache point.

### 3. Keep-alive: keep the cache fresh

The idea: proactively replay the last request with `max_tokens: 1` during idle to
reset the cache TTL before it expires.

- **3.1 The session abandonment problem.** How do we know the user is coming back?
  - **Signal A: process liveness.** The strongest signal. If the agent process
    (claude/opencode) has exited, the session is definitively over. Detection methods:
    - `aap run` spawns the agent as a child process → receives `SIGCHLD`/`exit` event
      directly. Zero false positives.
    - For externally-launched agents, the session's `meta.pid` can be checked via
      `process.kill(pid, 0)` (POSIX: no signal sent, just checks existence).
    - Armada-based sessions: the armada node reports lifecycle via the orchestrator
      and cleans up tmux windows on completion.
  - **Signal B: explicit session-end notification.** The agent calls the proxy to say
    "I'm done." See §3.4 below for proxy↔agent communication.
  - **Signal C: recent user interaction.** If the last request was < 5 min ago and
    contained a user message (not just tool results), the user is actively interacting.
  - **Signal D: git activity.** If `git status` shows the working tree changed since
    the last request, the user is editing files → likely to return within the session.
  - **Signal E: terminal/tmux liveness.** If the session was launched in a tmux window,
    check if the window still exists (`tmux list-windows -t session`). A destroyed
    window = user manually ended the session.
  - **Signal F: time-of-day heuristics.** Don't ping during typical off hours (12-2pm
    lunch, after 7pm, weekends). Don't ping if the session has been idle > 2h without
    any other signal.
  - **Signal G: explicit opt-in.** The user registers a session with
    `{ keepAlive: true }` via the control endpoint. Default: off. Requires the user
    to anticipate a long session with idle gaps.
  - **Confidence scoring.** Combine signals into a weighted score (`process alive = 0.9`,
    `explicit end = 0.0`, `recent git = 0.3`, `recent user msg = 0.5`, etc).
    Ping only when confidence > threshold (e.g. 0.5). A single strong negative
    (process died) overrides all positives.
  - **Abandonment policy:**
    - If a keep-alive ping triggers a cache WRITE (`cache_creation > 0`): stop
      immediately — the cache was already dead and we're burning money.
    - If the agent process exits: stop immediately, clear the timer.
    - If the user doesn't return within N consecutive pings: stop, mark session
      as "abandoned" in metadata.
    - If confidence score drops below threshold mid-cycle: stop.
- **3.2 Ping cost model.**
  - On the 5m cache: ping every 4.5 min → ~12.5 pings before break-even (one
    rebuild costs ~$1.25 for a 200K prefix on Opus 4.x; 12.5 reads cost ~$1.25).
    Barely breaks even — not worth the complexity.
  - On the 1h cache: ping once/hour → ~12 pings before break-even (~$1.20 in
    reads vs. $10 write on 200K prefix). **Requires `upgradeCacheTtl` to be
    enabled and verified first.**
- **3.3 Implementation sketch.**
  ```
  Per-session state:
    lastRequestBytes: Buffer       // the last sent request (for replay)
    lastRequestModel: string        // for pricing
    keepAliveTimer: Timer | null
    pingCount: number
    sessionActive: boolean          // from signals A-E above

  On each proxy request:
    update lastRequestBytes
    reset pingCount
    evaluate sessionActive signals

  On idle timer (~TTL * 0.8):
    if not sessionActive: stop
    if pingCount > maxPings: stop
    replay lastRequestBytes with stream:false, max_tokens:1
    if response has cache_creation > 0: stop (cache was dead, we're burning money)
    pingCount++
  ```
  **Transparency caveat:** these are phantom API calls the user never issued.
  They consume real quota and appear in billing. Must be opt-in and clearly
  documented.

### 3.4 Proxy ↔ agent communication

Currently the proxy is a transparent pipe: the agent doesn't know it exists, and
the proxy only observes traffic. For keep-alive and session lifecycle, we need the
agent to tell the proxy things ("I'm done", "I'm about to Compact", "here's my pid").
Several channels exist:

- **3.4a Control endpoint (already exists).** `POST /_control/sessions` registers a
  session with metadata. `aap run` already calls this to register the session before
  launching the agent. Extend it with:
  - `POST /_control/sessions/{id}/end` — agent signals session completion.
  - `POST /_control/sessions/{id}/hb` — lightweight heartbeat. Agent calls this
    periodically (every 30s). If heartbeats stop → agent died.
  - `POST /_control/sessions/{id}/compact` — agent signals a pending compaction.
    The proxy can piggyback additional deterministic transforms on this event.
  - Register with `{ pid: number, keepAlive: boolean, cwd: string }` on session start.
  - The control endpoint already exists, is local-only (127.0.0.1), and handles
    JSON bodies. Adding new routes is trivial.

- **3.4b Environment variable injection.** `aap run` already sets env vars before
  launching the agent (e.g., `OPENCODE_CONFIG_CONTENT`). Add:
  - `AAP_SESSION_ID` — the agent knows its session id.
  - `AAP_PROXY_URL` — the agent knows where to call back (`http://127.0.0.1:8080`).
  - `AAP_KEEP_ALIVE=1` — the agent knows keep-alive is active and can adjust behavior
    (e.g., avoid aggressive timeouts).
  - Claude Code / opencode don't natively use these, but `aap run` wraps the launch
    and can inject a pre-exit hook (trap EXIT) that calls the end endpoint.

- **3.4c Process hierarchy.** When `aap run` spawns the agent, the proxy is the
  grandparent (or sibling via the launcher). The launcher can:
  - Pass the agent's pid to the proxy at registration time.
  - Monitor the agent's exit and call `/_control/sessions/{id}/end` on the proxy.
  - Use `child_process.on('exit')` — no polling, zero latency.
  - On SIGTERM/SIGINT, the launcher can send an end signal before killing.

- **3.4d Shell hook injection.** `aap run` wraps the agent command with a shell
  script that traps exit and curl-calls the proxy:
  ```bash
  #!/bin/bash
  trap 'curl -s -X POST http://127.0.0.1:8080/_control/sessions/$AAP_SESSION_ID/end' EXIT
  exec claude "$@"
  ```
  This works with any agent (claude, opencode, ollama) without modification.
  The trap fires on normal exit, Ctrl+C, and SIGTERM.

- **3.4e In-band protocol (speculative).** The proxy could inject metadata into
  the API response headers that the agent reads:
  - `x-aap-session-id: <id>` on every response.
  - `x-aap-cache-status: warm|cold|unknown` — the agent could use this to decide
    whether to compact or continue.
  - **Problem:** Claude Code and opencode don't consume custom headers. This
    requires agent-side changes, which makes it the least viable option.

- **3.4f Recommendation.** Start with 3.4b + 3.4d (env vars + shell trap) for
  `aap run`, and 3.4a (control endpoint) for externally-launched agents. These
  require zero changes to the agents themselves and give the proxy definitive
  session-start and session-end signals. Add the heartbeat endpoint later if
  mid-session crash detection becomes important.

### 4. Find bugs

- **4.1 `frozenCompact` tool message pairing.** Fixed in this branch. Still needs
  real-session verification: run `aap serve --optimize` against a long DeepSeek
  session and confirm the API doesn't reject any requests.
- **4.2 `stripTools` interaction with tool_use blocks.** If a tool is stripped
  from the `tools[]` definition but a message contains a `tool_use` block
  referencing it, does the API reject? Test with both Anthropic and OpenAI formats.
- **4.3 Body buffer truncation.** The proxy buffers the entire request body
  (`MAX_CONTROL_BODY` limits control endpoint, but proxy requests have no limit).
  A 2MB request body (common in long sessions) could cause memory pressure.
- **4.4 Concurrent session isolation.** Each session gets its own `OptimizeLayer`
  instance. Verify that tool-call tracking (`seenCalls`, `recentWrites`) doesn't
  leak between sessions when multiple agents run simultaneously.
- **4.5 Response body corruption.** The proxy streams responses unbuffered.
  If the upstream connection drops mid-stream, does the client get a truncated
  response without error? Add integration test for upstream disconnect.
- **4.6 Quick-open sessions from hydration.** On restart, sessions are hydrated
  from SQLite. Does the optimizer state (turn count, seen calls, write records)
  get restored? Currently it does NOT — a restart loses the optimizer's memory,
  potentially changing behavior mid-session.
- **4.7 Ollama provider path mapping.** `aap run ollama` sets `OLLAMA_HOST` to
  point at the proxy, but Ollama's API paths differ from OpenAI's. Verify that
  tool responses are correctly captured and parsed.

### 5. Clean up code

- **5.1 Remove dead strategy implementations.** `dedup`, `truncate`, `suppressReread`,
  `pruneStale`, `collapseSystem`, `pruneUnusedTools`, `stablePrefix`, `reorderVolatile`,
  `insertBreakpoints` are all disabled in every active profile. They exist only for the
  `none` cache family (Ollama) where there's no cache to protect. Either document them
  as Ollama-only or remove the code.
- **5.2 Unify config sources.** The optimizer config is spread across: Zod schema
  defaults, `DEFAULT_CONFIG` in layer.ts, per-profile overrides (`CACHE_SAFE_OVERRIDES`,
  `EXPLICIT_CACHE_OVERRIDES`), and user's TOML config. This is four layers of defaults
  that interact with `{ ...a, ...b, ...c }` spread merging. Simplify to a single
  resolution function with explicit priority: profile > user config > hardcoded defaults.
- **5.3 Simplify `OptimizeConfig` interface.** Remove fields that are no longer
  functional: `optimizeOnCold`, `cacheTtlMs` (only used by optimizeOnCold),
  `pruneStabilityWindow` (dead code). Mark deprecated fields with `@deprecated`.
- **5.4 Extract optimizer from proxy hot path.** The optimizer runs synchronously
  on every proxy request, parsing and re-serializing the full JSON body. For a 200K
  token request, JSON.parse + JSON.stringify is ~5-10ms. Move to a worker thread or
  at minimum profile the CPU cost for large sessions.
- **5.5 Test coverage for cache-aware strategies.** `stableTruncate` and
  `shapeTestOutput` have unit tests for the transform logic, but no integration test
  verifying they produce identical bytes across multiple turns with a real upstream.
  Add an idempotency test: same input → same output, measured via actual byte comparison.
- **5.6 Remove `tailTruncate` implementation.** The strategy is proven broken and
  all profiles have disabled it. Either remove the code entirely or add a `@deprecated`
  comment and a console warning when enabled.

### 6. Additional suggestions

- **6.1 Response-path optimization revisit.** `dedup`, `truncate`, and `suppressReread`
  are documented as "response-path" strategies that were never wired into the live proxy.
  They modify tool result content in API responses. This is fundamentally different from
  request rewriting: the response is ephemeral (the model only sees it once). So cache
  coherence doesn't apply. If these strategies ACTUALLY work on responses, they could be
  safe for all providers. Verify and wire them in.
- **6.2 Cost projection before enabling.** Add an `aap simulate` or `aap optimize --dry-run`
  command that replays a captured session through the optimizer and reports projected
  savings without making live API calls. This lets users test configs safely.
- **6.3 Per-strategy A/B measurement.** Instead of all-or-nothing `--optimize`, allow
  running with individual strategies toggled. Log per-strategy token savings and cache
  impact. This would let us measure the real effect of each strategy in isolation.
- **6.4 Dashboard integration.** Surface optimize actions in the UI: which strategies
  fired on which requests, how many tokens were saved, and whether cache hit rate
  changed. Currently optimize actions are logged to stderr and stored in SQLite but
  not visible in the dashboard.
- **6.5 Session size alerts.** Warn (in dashboard or logs) when a session exceeds a
  configurable token budget. This is the "profile, don't rewrite" approach: tell the
  user their session is expensive and let them decide to Compact or start fresh.

- **Non-deterministic transforms** — any transform whose output depends on time, turn
  number, or global state will produce different bytes every turn and trigger cache
  rebuilds.
