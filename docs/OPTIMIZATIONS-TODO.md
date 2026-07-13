# Optimization Roadmap

Based on analysis of real sessions (931-req/$38, 168-req/$24, 71-req/$2), these are
the next optimizations to implement, ordered by estimated impact.

## 1. IASH — Intelligent Agent Shell

**Impact: High | Complexity: Medium**

Instead of truncating large Bash outputs after the fact (head+tail loses context),
intercept shell commands before execution and rewrite them to produce bounded, useful
output.

### Strategy

| Pattern               | Rewrite                                                                 | Rationale                                 |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `find . -name "*.ts"` | `find . -name "*.ts" \| head -100 && echo "[truncated]"`                | 47K tokens from unbounded find            |
| `grep -r pattern .`   | `grep -rl pattern . \| head -30` (filenames only)                       | 25K tokens from full-content grep         |
| `cat large-file`      | Return line count + first/last N lines + prompt to use Read with offset | 26K tokens from full file dumps via shell |
| `git log`             | `git log --oneline -20`                                                 | Unbounded history                         |
| `npm test` / `pytest` | Capture exit code + last 50 lines (trim passing tests)                  | Test output is mostly noise on pass       |

### Architecture

```
Request body → parse tool_use(Bash) → classify command → apply rewrite rules → forward
Response → if output > threshold, post-process with summarizer
```

The key insight: this operates on the _tool_use input_ (command text), not the output.
It's a pre-execution optimization that prevents waste rather than recovering from it.

### What this is NOT

- Not a separate shell implementation
- Not a sandbox or security layer
- It's a transparent rewrite layer in the optimize pipeline that makes commands
  produce less noisy output while preserving signal

### Estimated savings

From session 2d0e8384: `find` (47K), `grep` (25K), `cat` (26K) = ~98K result tokens.
With IASH: estimated ~15K result tokens. **Saves ~83K tokens per session.**

---

## 2. Adaptive pruneUnusedToolsAfter

**Impact: Medium | Complexity: Low**

Current: fixed threshold of 10 turns before pruning kicks in.
Problem: in a 931-request session, the first 10 requests still send all 18 tool defs.

### Strategy

Track tool usage velocity. If by turn 5 only 3 tools have been used across 15+ tool
calls, the pattern is converged — prune immediately. Formula:

```
converged = (turn >= 3) && (toolCallsSeen >= turn * 2) && (newToolsLastTurn === 0)
```

This adapts to sessions that take longer to settle (exploring) vs sessions that lock
into a pattern immediately (iterative fix/test cycles).

### Estimated savings

From ~7,141 tool tokens/request × 5 early requests saved = ~36K tokens per session.

---

## 3. Search-result dedup

**Impact: Medium | Complexity: Low**

Session 2d0e8384 ran the same `find` and `grep` patterns multiple times. Current dedup
catches identical tool+args, but Bash commands with slight variations (`find . -name
"*.ts"` vs `find . -name "*.ts" -type f`) produce overlapping results.

### Strategy

For Bash commands classified as `search`:

1. Extract the search target (pattern, directory, file glob)
2. Hash the search intent (normalize flags, canonicalize paths)
3. If a semantically-equivalent search ran within N turns and the working tree hasn't
   changed (no Write/Edit between), return `[same results as turn N — K files]`

### Estimated savings

48 identical Bash calls × ~600 tokens avg result = ~29K tokens.

---

## 4. Fuzzy system-prompt collapse

**Impact: Medium | Complexity: Medium**

`collapseSystem` requires byte-identical prompts. Claude Code's system prompt changes
slightly per request (date stamps, memory updates, context summaries). 1.8M system
tokens across 931 requests suggests the collapse isn't firing.

### Strategy

1. Split system prompt into segments (by `\n\n` or known section markers)
2. Hash each segment independently
3. On repeat, only resend segments whose hash changed; replace stable segments with
   `[section unchanged — hash:abc123]`

This is essentially delta-compression for the system prompt.

### Estimated savings

System prompt ~1,937 tokens/request. If 80% is stable: saves ~1,550 tokens/request
× 931 requests = ~1.4M tokens. At cached rate ($1.50/M): **~$2.10 per session.**

---

## 5. Diff-based Read compression

**Impact: Low-Medium | Complexity: Medium**

Session 2d0e8384 re-read files 19+ times. When a file was read before and only a few
lines changed (from an Edit), sending the full content again is wasteful.

### Strategy

1. Store last-seen content hash + full text for each file path
2. On re-read, compute diff
3. If diff is small (< 20% of file), return:
   `[file mostly unchanged since turn N — diff: +3/-1 lines]\n<actual diff>`

### Estimated savings

233K Read result tokens. If 50% are re-reads of slightly-changed files:
~116K tokens × 80% compression = ~93K tokens saved.

---

## 6. Test output compression

**Impact: Low | Complexity: Low**

`npm test` / `pytest` / `vitest` output is mostly noise when tests pass. The agent
only needs: pass/fail, failure details, count.

### Strategy

Detect test runner output (by command prefix or output patterns). On pass:

```
[tests passed: 48/48 in 2.3s]
```

On failure, keep only the failing test output + summary.

### Estimated savings

Varies by session. In benchmark sessions: ~5-10K tokens per test run × N runs.

---

## 7. normalizePrefix — Team-Shared Cache

**Impact: High (scales with team size) | Complexity: Medium-High**

On Bedrock, the cache key is the exact byte prefix. Different users on the same project
produce different prefixes because of user-specific paths, memory, git status — so each
developer creates (and pays for) their own cache entries.

### Strategy

The proxy rewrites user-specific bytes to a canonical team-wide form before forwarding
to Bedrock, and rewrites responses back to real paths for the client.

**Bidirectional path normalization:**

```
→ To Bedrock:    /Users/raulguiu/code/rmt-portfolio-service → /p/rmt-portfolio-service
← From Bedrock:  /p/rmt-portfolio-service → /Users/raulguiu/code/rmt-portfolio-service
```

Each team member maps their project root to the same canonical prefix:

```toml
# Per-user proxy config
[normalize]
paths = [
  { real = "/Users/raulguiu/code", canonical = "/p" },
  # John: { real = "/home/john/projects", canonical = "/p" },
  # CI:   { real = "/workspace", canonical = "/p" },
]
```

**Why absolute paths:** The LLM generates tool calls with absolute paths (Read, Edit
require them). We cannot use `~` or `$ENV_VAR` — the model would pass those literally
and the tools would fail. The canonical form must be a valid-looking absolute path.

### What gets rewritten

| Direction  | What                                                     | Example                                                       |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| → request  | System blocks (working dir, CLAUDE.md paths)             | `/Users/raulguiu/code/proj` → `/p/proj`                       |
| → request  | Tool results (file contents, command outputs with paths) | same                                                          |
| ← response | Tool calls (Read/Edit file_path arguments)               | `/p/proj/src/foo.ts` → `/Users/raulguiu/code/proj/src/foo.ts` |
| ← response | Text content (file references in explanations)           | same                                                          |

### What stays user-specific

Content after the last `cache_control` breakpoint is always a cache write anyway:

- Personal memory files
- Current git status / uncommitted changes
- Latest user message + tool results

These do NOT need normalization — they don't benefit from cross-user cache sharing.

### How it interacts with Bedrock's cache

Rates below are Opus 4.x, 5m cache ($6.25/MTok write, $0.50/MTok read).

```
User A (first today): system[normalized] + tools → WRITE ($6.25/MTok on ~24K tokens = $0.15)
User B (same window):  system[normalized] + tools → READ ($0.50/MTok on ~24K tokens = $0.012)
User C (same window):  system[normalized] + tools → READ ($0.012)
User D (same window):  system[normalized] + tools → READ ($0.012)
User E (same window):  system[normalized] + tools → READ ($0.012)
```

### Estimated savings

System + tools prefix: ~24K tokens.

- Cold write: 24K × $6.25/MTok = $0.15
- Warm read: 24K × $0.50/MTok  = $0.012

Per cold window, savings = (N-1 users) × ($0.15 - $0.012):

- 5-person team: ~$0.55 saved per cold window
- 10-person team: ~$1.24 saved per cold window

Over a workday (~50 cold windows with activity gaps):

- 5-person team: **~$28/day** potential savings

Note: with the 5m cache these windows are short, so cross-user overlap is
rarer than it looks — rewriting Claude Code's markers to a **1h TTL** (write
$10/MTok, 2× input) widens each window 12×, making shared warm reads far more
likely. The higher write cost is amortised across many more reads.
- Depends on concurrent usage within TTL windows

### Challenges

1. **Correctness** — Path rewriting must be exact and bidirectional. A missed rewrite
   breaks tool execution. Needs thorough regex coverage of all path formats.
2. **Non-path user specifics** — Username in git config, user-specific memory content.
   These appear in system blocks and break prefix sharing. May need to extract and move
   after the last breakpoint.
3. **Project alignment** — Team members must agree on which projects map to which
   canonical paths. Configuration overhead.
4. **Partial matches** — If system prompts differ for other reasons (different Claude
   Code versions, plugins, skills loaded), the prefix still diverges.

### Prerequisites

- Team uses the same Claude Code version and plugin set
- Shared CLAUDE.md per project (already committed to git)
- Proxy deployed as a shared team service (not per-machine)
- Each user configures their path mappings

---

## 8. optimizeOnCold — Full Optimization After Cache Expiry ❌ BUILT, DEFAULTED OFF

**Status: built, found flawed, default OFF. Not recommended.**

> **Why it doesn't work.** Implemented in `src/optimize/layer.ts` (`COLD_START_CONFIG`,
> cold-start detection in `rewriteRequestBody`), then defaulted off. The premise ("the write
> is happening anyway, so shrink it for free") ignores the reproducibility rule: the layer
> applies the aggressive edits only on the cold turn, then reverts. The **next** turn the
> client re-sends the pristine full prefix (it never learns we edited it), which diverges
> from the shrunk prefix we just cached → the whole prefix rebuilds → **two writes instead
> of one**, strictly worse than doing nothing. Only deterministic edits could be sustained
> across the following turns, and those are safe to run always — so gating them on "cold"
> adds nothing. See docs/OPTIMIZATION-STRATEGIES.md ("Attempts that did not pay off").
> Original (now-invalidated) design notes preserved below for reference.

When a user returns after the cache TTL has expired, the next request pays full cache-write
cost regardless. This is the optimal moment to apply aggressive optimizations — the prefix
is being rewritten anyway, so making it smaller costs nothing extra.

### Strategy

Track `lastRequestAt` per session. On incoming request:

```
if (now - lastRequestAt > CACHE_TTL_MS) {
  // Cache is dead — apply full optimization (dedup, prune, collapse, truncate)
  // The write is happening anyway, make it smaller
} else {
  // Cache is warm — pass through unchanged
}
```

After the optimized write, the session continues with a **smaller** cached prefix,
making every subsequent read cheaper for the rest of the TTL window.

### Estimated savings

A 200K-token session returning after cache expiry (Opus 4.x, 5m write $6.25/MTok):

- Without: writes 200K tokens at $6.25/MTok = $1.25
- With pruning/dedup: writes 150K tokens at $6.25/MTok = $0.94
- Saves: ~$0.31 per cold return, plus cheaper reads for all subsequent turns

### Configuration

```toml
[optimize]
cacheTtlMs = 1800000   # 30 min (only relevant if you re-enable optimizeOnCold)
optimizeOnCold = false # OFF by default — causes a double write (see above)
```

---

## 9. optimizeOnCompaction — piggyback on a client-side history shrink (speculative)

**Impact: Uncertain (likely small) | Complexity: Medium | Status: idea only**

This is the salvageable core of the abandoned `optimizeOnCold` (§8). That one failed because
the proxy shrank the prefix on a turn the *client didn't know about*, so the client re-sent
the full prefix next turn and forced a second write. The one moment that failure mode does
NOT apply is when **the client itself rewrites its history** — i.e. Claude Code's Compact.

When Compact fires, Claude Code summarises older turns and replaces them in its own local
state, then re-sends the *compacted* history every subsequent turn. So:

- A prefix rebuild is happening **anyway** (client-initiated), and
- The new shorter prefix is now the client's source of truth, so it **is** reproduced every
  turn — the reproducibility rule is satisfied *by the client*, not by us.

The idea: **detect a client-side compaction** (the prefix legitimately shrank / diverged
early without an idle gap — distinguishable from a cache expiry via the cache-regen signals)
and piggyback additional *deterministic* shrinking (stableTruncate, shapeTestOutput) onto
that same unavoidable write. No double write, because the client keeps sending the new form.

### Why it's probably NOT significant

- The extra shrink rides on top of Compact, which has *already* removed the bulk of the
  history — the marginal tokens left to trim are small.
- The deterministic strategies we'd apply are safe to run **every turn anyway**, so most of
  their benefit is already captured without special cold/compaction handling.
- Detecting a compaction vs. any other prefix change reliably is non-trivial and easy to get
  wrong (a false positive re-introduces the double-write bug).

So the realistic upside is "a slightly smaller write on compaction turns," not a step change.
Worth prototyping only if compaction turns out to be frequent and expensive in real traces.
Needs data first: how often does Compact fire, and how big are those writes?

---

## Priority Order

- ❌ **optimizeOnCold** — built, found to cause a double cache write, defaulted OFF. Not recommended.
- ❓ **optimizeOnCompaction** — speculative salvage of the above; likely small upside, needs data first.
1. **IASH** — highest ROI, prevents waste at source
2. **normalizePrefix** — high savings that scale with team size (needs shared proxy)
3. **Adaptive pruneAfter** — trivial to implement, immediate savings
4. **Search-result dedup** — low-hanging fruit on top of existing dedup
5. **Fuzzy system collapse** — high savings but more complex
6. **Diff-based Read** — medium savings, needs careful correctness
7. **Test output compression** — nice-to-have, pattern-specific

## Data backing these estimates

```
Session 2d0e8384 (ebury-risk-base-account):
  931 requests, $38.13, 5 tools used / ~18 defined
  Bash: 604 calls, ~293K result tokens
  Read: 180 calls, ~233K result tokens
  find: 78 calls, ~47K result tokens
  grep: 56 calls, ~25K result tokens
  cat:  51 calls, ~26K result tokens
  System resent: 1.8M tokens
  Tool-defs resent: 6.6M tokens

Session 2f6af617 (ai-agent-profiler):
  168 requests, $24.17, 5 tools used / ~30 defined
  Read: 45 calls, ~44K result tokens
  Edit: 40 calls, ~2K result tokens
  Bash: 39 calls, ~3.6K result tokens
  Tool-defs resent: 2.1M tokens (~12,214 tok/request)

Session c61f4fe9 (risk-ai-infra):
  71 requests, $2.07, 5 tools used / ~32 defined
  Bash: 46 calls, ~5.8K result tokens
  Tool-defs resent: 897K tokens (~12,639 tok/request)
```
