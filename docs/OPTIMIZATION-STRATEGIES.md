# Optimization strategies — catalogue, status, and lessons

A reference for every request-rewriting strategy the optimize layer implements: what it
does, which cache family it is safe for, and its current status. This is the "what we
built and learned" record; the narrative of _why_ the ambitious approaches failed is in
[`OPTIMIZATION-FINDINGS.md`](OPTIMIZATION-FINDINGS.md).

No cost/savings percentages are quoted here — earlier figures were produced before the
cost model accounted for cache-write tokens and are not trustworthy. Facts about cache
mechanics (write ≈ 12.5× read on Anthropic; DeepSeek miss ≈ 10× hit; ~2048-token minimum)
are retained because they explain the safety classification. If reliable improvement
numbers are measured later, they can be added here.

---

## Cache families

The layer keys its behaviour off the provider's cache family
(`src/optimize/profiles.ts`):

| Family     | Providers                   | Cache mechanism                       | Consequence for editing the prefix                                |
| ---------- | --------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `prefix`   | DeepSeek, OpenAI-compatible | Automatic longest-common token prefix | Any edit re-bills the downstream tail at the miss rate (~10× hit) |
| `explicit` | Anthropic, Bedrock          | Client `cache_control` breakpoints    | Any edit turns cheap reads into writes (~12.5× read)              |
| `none`     | Ollama, unknown             | No upstream prompt cache              | Nothing to protect; edits are free                                |

See [`agents/deepseek.md`](agents/deepseek.md) and
[`agents/anthropic.md`](agents/anthropic.md) for the per-provider detail.

---

## Why edits must be reproduced

The proxy edits are **ephemeral and one-directional**. Claude Code holds the entire
conversation locally and rebuilds the full request from scratch every turn; the model
returns only the new assistant message, never the conversation. **Claude Code never learns
that the proxy changed anything.** So:

- The client re-sends the **pristine, unmodified** history every turn (plus the new reply).
- A proxy edit on turn N is _not_ remembered by anyone — if the layer doesn't re-apply the
  exact same edit on turn N+1, the emitted bytes diverge from what was cached and the cache
  rebuilds from the divergence point.

This is the whole reason `OptimizeLayer` is stateful and re-runs every transform on every
request. It also means a "safe" edit must be **reproducible byte-for-byte regardless of
where the content now sits in the message list** — an edit that only fires for the _newest_
message (like `tailTruncate`) fails this, because the content it edited moves into the
middle of history next turn and is then re-sent in full. See the `tailTruncate` note below.

## Safety classification

The single rule that determines safety: **does the strategy change bytes before a cache
boundary?**

- **Prefix-safe** — only ever touches content at/after the trailing edge, or removes
  content _before the first cached request is ever written_ so the prefix is stable from
  turn 1. Safe on all families.
- **Prefix-editing** — modifies system, tools, or earlier messages mid-session. Unsafe on
  both `prefix` and `explicit` families; only acceptable on `none`.

| Strategy            | What it does                                                               | Class          | prefix (DeepSeek) | explicit (Anthropic) |
| ------------------- | -------------------------------------------------------------------------- | -------------- | ----------------- | -------------------- |
| `stripTools`        | Remove named tool defs from turn 1 (stable prefix from the start)          | prefix-safe    | ok                | ok                   |
| `tailTruncate`      | Truncate large tool results only on the trailing-edge message              | **NOT safe**†  | harmful           | harmful              |
| `stableTruncate`    | Deterministic head+tail truncation, re-applied to every matching result    | prefix-safe*   | ok                | disabled             |
| `shapeTestOutput`   | Strip passing-test spam / ANSI / dupes from test output, deterministically | prefix-safe*   | ok                | disabled             |
| `dedup`             | Replace an identical repeat tool result with a stub                        | response-path  | n/a live          | n/a live             |
| `truncate`          | Head+tail trim of oversized results (response path)                        | response-path  | n/a live          | n/a live             |
| `suppressReread`    | Skip re-reading a file just written                                        | response-path  | n/a live          | n/a live             |
| `pruneStale`        | Summarise old tool results in the message history                          | prefix-editing | disabled          | disabled             |
| `pruneUnusedTools`  | Remove never-used tool defs mid-session                                    | prefix-editing | disabled          | disabled             |
| `collapseSystem`    | Replace the repeated system prompt with a hash stub                        | prefix-editing | disabled          | disabled             |
| `stablePrefix`      | Canonicalise tool-definition JSON key order                                | prefix-editing | disabled          | disabled             |
| `reorderVolatile`   | Move volatile `<system-reminder>` blocks toward the tail                   | prefix-editing | disabled          | disabled             |
| `insertBreakpoints` | Re-anchor `cache_control` markers after edits                              | prefix-editing | disabled          | disabled             |
| `frozenCompact`     | Fold old messages into one frozen summary past a threshold                 | prefix-editing | disabled          | disabled             |

\* `stableTruncate` / `shapeTestOutput` are prefix-safe because the transform is a **pure
function of the content**, re-applied identically to **every** matching result on **every**
turn regardless of position. So a result `R` maps to the same truncated bytes `T` whether
it is the newest message or buried deep in history — the emitted prefix never diverges.
They are enabled under DeepSeek's cache-safe profile but disabled on Anthropic (where the
native cache already handles the unmodified prefix and any change forces a write).

† **`tailTruncate` is NOT prefix-safe — this reclassifies it from earlier docs.** It
truncates a large result _only in the last user message_. That looks safe (the tail is
always a write anyway), but it ignores what the client does next turn:

- **Turn N**: `[…prefix…][big result R]` — `R` is the tail; the proxy truncates it to `T`
  and that gets written.
- **Turn N+1**: Claude Code does **not** know we edited anything (see
  [the client re-sends the full history every turn](#why-edits-must-be-reproduced)). It
  re-sends the pristine `[…prefix…][full R][assistant reply][new tail]`. Now `R` sits
  _mid-history_, so `tailTruncate` (which only touches the newest message) leaves it
  **full**. The cache had `…T` but the request sends `…full R` → **divergence at R →
  everything from R onward is re-billed as a cache write.**

So `tailTruncate` doesn't hold its own edit: the client "undoes" it one turn later and the
proxy doesn't re-shrink it, forcing a rebuild. On Opus 4.x that rebuild (write at 12.5× the
read rate) costs far more than the one-turn tail saving — a net loss, not the "~$0.03 save"
the old benchmark suggested (that figure was within noise). `stableTruncate` avoids this
precisely because it re-truncates `R` on every turn, keeping the bytes stable.

**Status:** analytically established; pending empirical confirmation against captured
sessions (look for a `cache_creation` spike on the turn _after_ a `tail_truncate` action).
The Bedrock default should move from `tailTruncate` to `stableTruncate` if confirmed.

The response-path strategies (`dedup`, `truncate`, `suppressReread`) act on tool-result
content and are **not currently invoked by the live proxy** — they exist in the layer and
the simulator only. Wiring them into the live request path is listed in
[`OPTIMIZATIONS-TODO.md`](OPTIMIZATIONS-TODO.md).

---

## Attempts that did not pay off

These were built and evaluated, then disabled on cached providers because editing the
prefix costs more than the tokens saved:

- **`pruneStale`, `collapseSystem`, `pruneUnusedTools`, `stablePrefix`,
  `reorderVolatile`, `insertBreakpoints`, `frozenCompact`.** Each reduces prompt size but
  changes bytes before a cache boundary. On `prefix` providers this re-bills the tail at
  the miss rate; on `explicit` providers it converts reads to writes. Early benchmarks
  suggested large wins for some of these, but those results were confounded by
  cross-session cache warming and a cost model that ignored cache-write tokens. See
  [`OPTIMIZATION-FINDINGS.md`](OPTIMIZATION-FINDINGS.md).

- **Byte-prefix stability probe (DeepSeek).** An early diagnostic flagged "cache resets"
  on healthy append-only traffic because it diffed raw bytes and was fooled by the
  `messages…tools` ordering. Replaced by a structural / real-`usage`-based check.

- **`optimizeOnCold` (built, then defaulted OFF).** The idea: when the cache has already
  expired (idle > `cacheTtlMs`), the next request pays a full write regardless, so apply
  the full prefix-editing set for that one turn to shrink what gets written. The flaw is
  the same reproducibility rule as `tailTruncate`:

  - **Cold turn N:** collapses system `S→S'`, prunes history `M→M'`, writes `S' T M'`.
  - **Turn N+1:** the layer reverts to the steady-state set, so `collapseSystem`/`pruneStale`
    are OFF. The client re-sends the pristine full `S T M …` (it never knew we edited it).
    Cache holds `S'`; request sends `S` → divergence at the _first bytes_ → the **entire
    prefix rebuilds**.

  Net result is **two writes instead of one** — strictly worse than doing nothing. The only
  edits that could be _sustained_ across the following turns are the deterministic ones
  (`stableTruncate`, `shapeTestOutput`, `stripTools`) — and those are safe to run _always_,
  so gating them on "cold" adds nothing. So `optimizeOnCold` is either redundant or harmful,
  with no configuration where it's a clear win. Left in the code, configurable, default OFF.

---

## Configuration

Strategies are toggled in `[optimize]` (see `config.example.toml`); the `profile`
(`auto` / `default` / `cache-safe`) plus the provider's cache family decide which
overrides apply. With `profile = "auto"` (default) the correct safe set is chosen per
provider automatically — no manual tuning needed.

---

## Future directions

Ideas designed but not implemented (or not yet validated) live in
[`OPTIMIZATIONS-TODO.md`](OPTIMIZATIONS-TODO.md): prefix normalization for team-shared
caches, IASH (intelligent agent shell), and the two cache-lifetime levers below.

### `upgradeCacheTtl` — 5m → 1h (shipped, off by default)

Claude Code always requests the 5-minute cache (verified: every captured `cache_control`
marker is bare `{"type":"ephemeral"}`). The proxy can rewrite those markers to a 1-hour TTL
before forwarding. A 1h write costs 2× input ($10/MTok on Opus 4.x) vs 1.25× for 5m
($6.25); reads are identical ($0.50). Worth it when idle gaps often fall in the 5m–1h range
(fewer re-writes) and it widens the window for cross-user cache sharing 12×.

### keep-alive pings — interesting _only atop the 1h cache_

Proactively replay the last request (`max_tokens: 1`) during idle so a cache _read_ keeps
resetting the TTL instead of letting it expire. The economics hinge on the write/read
ratio (12.5× on 5m):

- **On the 5m cache:** ping every ~4.5 min; ~12.5 pings ≈ 56 min before keep-alive costs
  as much as one rebuild. Barely breaks even — not worth it.
- **On the 1h cache:** ping ~~once/hour (~~$0.10/hr for a 200K prefix) vs ~$1.25 per rebuild.
  Break-even ≈ **12 hours** of idle. Dramatically cheaper.

Caveats that keep it a _future_ idea, not a default: it's a **bet the user returns** (wasted
if they don't), it originates **phantom API calls** the user never issued (real cost, quota,
billing "activity"), it **breaks the proxy's transparency** (no longer a passive pipe), and
it needs the **real TTL** (unmeasured) to time the ping. Sequencing: gather TTL data →
confirm `upgradeCacheTtl` helps → _then_ consider keep-alive as an opt-in 1h-cache add-on.

> **Note:** `optimizeOnCold` used to be listed here as "the most promising." It was built,
> found to cause a double cache write (see _Attempts that did not pay off_), and defaulted
> OFF. It is not a recommended direction.
> </content>
