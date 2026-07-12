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
| `tailTruncate`      | Truncate large tool results only on the trailing-edge message              | prefix-safe    | ok                | ok                   |
| `stableTruncate`    | Deterministic head+tail truncation applied on a result's first appearance  | prefix-safe*   | ok                | disabled             |
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

\* `stableTruncate` / `shapeTestOutput` are only prefix-safe because the transform is a
pure function of the content and is applied the first time the result appears — the
truncated form is what gets cached, and it is never rewritten on later turns. They are
enabled under DeepSeek's cache-safe profile but disabled on Anthropic (where the native
cache already handles the unmodified prefix and any change forces a write).

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

---

## Configuration

Strategies are toggled in `[optimize]` (see `config.example.toml`); the `profile`
(`auto` / `default` / `cache-safe`) plus the provider's cache family decide which
overrides apply. With `profile = "auto"` (default) the correct safe set is chosen per
provider automatically — no manual tuning needed.

---

## Future directions

Ideas designed but not implemented (or not yet validated) live in
[`OPTIMIZATIONS-TODO.md`](OPTIMIZATIONS-TODO.md): `optimizeOnCold` (rewrite only when the
cache has expired, so the write happens anyway), prefix normalization for team-shared
caches, keep-alive pings, and IASH (intelligent agent shell). The most promising is the
cold/idle-session rewrite, since it is the one moment where shrinking the prompt does not
sacrifice a cache hit.
</content>
