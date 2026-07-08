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

## Priority Order

1. **IASH** — highest ROI, prevents waste at source
2. **Adaptive pruneAfter** — trivial to implement, immediate savings
3. **Search-result dedup** — low-hanging fruit on top of existing dedup
4. **Fuzzy system collapse** — high savings but more complex
5. **Diff-based Read** — medium savings, needs careful correctness
6. **Test output compression** — nice-to-have, pattern-specific

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
