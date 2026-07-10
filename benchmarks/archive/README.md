# Benchmark report archive

These are the raw, per-run benchmark reports, kept for provenance. **For the current,
consolidated findings start with [`../REPORT-optimize-layer.md`](../REPORT-optimize-layer.md)** —
it supersedes everything here and opens with a quick overview.

This folder exists because the results evolved as both the fixture and the measurement
tooling matured. Reading the reports in order shows how the conclusions changed — and why
some early numbers were wrong.

## Timeline

| Date       | Report                                  | Fixture              | Agent / provider      | Status                  |
| ---------- | --------------------------------------- | -------------------- | --------------------- | ----------------------- |
| 2026-07-07 | `REPORT-iterative-fix.md`               | `iterative-fix`      | Claude Code / Bedrock | superseded              |
| 2026-07-08 | `REPORT-iterative-fix-v2.md`            | `iterative-fix`      | Claude Code / Bedrock | superseded              |
| 2026-07-08 | `REPORT-iterative-fix-opencode.md`      | `iterative-fix`      | OpenCode / DeepSeek   | superseded — see caveat |
| 2026-07-10 | `REPORT-iterative-fix-plus-deepseek.md` | `iterative-fix-plus` | OpenCode / DeepSeek   | current raw data        |
| 2026-07-10 | `REPORT-iterative-fix-plus-bedrock.md`  | `iterative-fix-plus` | Claude Code / Bedrock | current raw data        |

## What changed, and why the early numbers moved

**1. The old fixture was easier.** `iterative-fix` had 6 modules / 7 bugs / 48 tests. The
current `iterative-fix-plus` has 7 modules / 9 bugs + 3 method stubs / 54 tests plus a
larger hidden edge-test set. Numbers are not comparable across the two fixtures.

**2. The DeepSeek cost accounting was wrong in the old reports.** This is the important one.
`REPORT-iterative-fix-opencode.md` reported a big optimize _win_ on DeepSeek (−78% cost).
That number is **not trustworthy**: the token accounting double-counted / mispriced cached
tokens for OpenAI-format providers. DeepSeek (OpenAI-compatible) reports `prompt_tokens`
with the cached portion **already included**, whereas the comparison logic assumed the
Anthropic convention (cached counted separately). Once `compare.ts` was made format-aware,
the true DeepSeek picture emerged — and it was the **opposite**: with the current optimize
layer, `pruneStale` on DeepSeek is a large cost _regression_, not a win. See the current
consolidated report for the corrected story.

**3. `pruneStale` only started acting on DeepSeek later.** In the old runs, `pruneStale`
was effectively a no-op on OpenAI-format traffic (it only matched Anthropic's array-shaped
tool results). So the old DeepSeek "win" actually came from other strategies. A later change
made `pruneStale` fire on OpenAI format too — which is what exposed the cache regression.

**4. Test scoring was added later.** Early reports scored task success from verify logs by
hand; the harness now scores fixture/edge suites automatically (after a couple of tooling
fixes documented in the current report).

## Bottom line

Treat the three `iterative-fix` reports as historical. Treat the two `iterative-fix-plus`
reports as the current **raw data** behind the consolidated
[`REPORT-optimize-layer.md`](../REPORT-optimize-layer.md). Where an old number disagrees
with the consolidated report, the consolidated report is right.

## Process docs (how the cross-provider study was run)

- `HANDOFF-cross-provider-eval.md` — the task brief handed to the Claude Code agent on the
  Bedrock machine (3-run design, config setup, hypotheses).
- `HANDOFF-claude-entry-prompt.md` — the short entry prompt used to kick that agent off.

Both describe a now-completed run; kept for provenance.
