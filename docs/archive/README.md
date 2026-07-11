# docs/archive — superseded documents

These are kept for history and to preserve the correction trail. **Do not cite them
as current.** The canonical, maintained docs are:

- `docs/OPTIMIZATION-STRATEGIES-REPORT.md` — Claude/Bedrock optimize results and mechanism.
- `docs/DEEPSEEK-CACHING.md` — DeepSeek cache mechanism + measured probe.
- `docs/DEEPSEEK-FINDINGS.md` — DeepSeek optimize results (post cache-safe layer).
- `benchmarks/DEEPSEEK-COMPARISON.md` — DeepSeek baseline vs optimize A/B.

---

## Why each file here was retired

### `OPTIMIZE-REPORT.md`

Superseded by `OPTIMIZATION-STRATEGIES-REPORT.md`.

- **Simulation-based conclusions:** its headline "cache-aware pruning" recommendation
  rests on a simulator that predicted `pruneStale` drops the cache hit rate to ~67%. The
  live Bedrock runs held ~100% (the file itself admits this in its "Real-World Benchmark
  Results" section). The correct mechanism is documented in the canonical report §6.
- **Model mix-up:** simulation tables are Haiku 4.5; the real runs are Opus 4.6.
- **Note on pricing:** its Opus rates ($5.00 input / $0.50 cache-read) are actually
  _correct_ for Opus 4.5–4.8. (Its Haiku figure $0.80/$0.08 is Haiku 3.5, not 4.5 — a
  minor slip.) The canonical report, by contrast, used the _deprecated_ Opus 4/4.1 rates
  ($15/$1.50) and has since been corrected.

### `OPTIMIZE-IDEAS.md`

Branch working-notes / findings log for `feat/deepseek-cache-optimize`. Useful as history,
not as a source of truth — it quotes the same Haiku simulation (67-88% hit) as if canonical.

### `CLAUDE-CACHING.md`

A **generic, ChatGPT-generated** Anthropic prompt-caching best-practices guide. It is not
wrong, but it is not this project's own measured work, and it describes an aspirational
layered layout (repository knowledge / long-term memory tiers) that the profiler does not
implement. The project's measured Claude cache mechanism now lives in
`OPTIMIZATION-STRATEGIES-REPORT.md` §3. Retired to keep the public surface = original,
measured research rather than generic AI-generated filler.
