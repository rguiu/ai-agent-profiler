# Claude JSONL wrapper — what needs to be built

The core idea: instead of proxy-side request rewriting (which destroys cache because
the client re-sends pristine history next turn), the wrapper modifies Claude's local
conversation JSONL files, so Claude re-sends the optimized history instead of the
original.

> ## ⚠️ VERIFIED REALITY (2026-07-13) — read this before building
>
> The original premise above ("Claude stores the optimized history and re-sends it
> identically every turn") is **only true across a reload boundary**, not within a
> running session. Verified empirically on this machine plus Claude Code docs
> (high confidence):
>
> **What is possible:**
> - **Edit the JSONL, then `claude --resume <id>` → the edit is honored.** Resume
>   reloads the full transcript from disk and rebuilds in-memory state from it.
>   This is the *only* runtime path to make Claude adopt an edited transcript.
> - `claude --session-id <uuid>` lets `aap run` fix the JSONL path up front (no
>   scanning/heuristics needed).
> - The `assistant` events carry real cache numbers in `message.usage`
>   (`cache_read_input_tokens`, `cache_creation_input_tokens`) — measure cache
>   behavior straight from the file, no proxy response parsing.
>
> **What is NOT possible:**
> - **No mid-session reload.** During a live session Claude holds the conversation
>   in memory and only *appends* to the JSONL (written asynchronously, lags memory).
>   No hook, signal (SIGHUP), file-watch, IPC, or plugin API forces a re-read.
>   `PreCompact` can only *block*, not rewrite; `FileChanged` can't trigger reload.
>   Editing the file while Claude runs does nothing to the current turn and races
>   with Claude's own flush (corruption risk).
> - **The wrapper can never *permanently* own the request stack.** Claude is the
>   source of truth and rebuilds each request from its own in-memory state. Editing
>   the JSONL gives Claude a modified *starting point* at the next load; from that
>   moment Claude owns the stack again (appends, auto-compacts, re-emits from memory).
>   So this is a **recurring intervention at every load boundary**, not a
>   set-once-forever change.
> - Forcing a resume automatically (kill + relaunch) is technically possible but
>   destroys an interactive TUI and triggers the cache write you were avoiding — only
>   sensible for headless/orchestrated runs, and even then only if many turns follow.
>
> **Consequence:** this feature is **compact-on-resume**, not transparent
> mid-session compaction. It applies at the free moment (the first post-load request
> is a full cache write anyway). See `OPTIMIZATION-PLAN.md` → "The fundamental
> constraint" and Idea H for the full analysis.
>
> Phase 0 shipped: `aap analyze-claude <id>` — read-only transcript analysis
> (`src/analyze/claude-transcript.ts`, `src/cli/analyze-claude.ts`).

## What we know about Claude's JSONL

**Path:** `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
(the slug is the absolute cwd with every `/` and `.` replaced by `-`).

**Format:** One JSON *event* per line — richer than "one message per line":

- **It is a TREE, not a flat log.** Events chain via `parentUuid → uuid`.
  Rewind/edit/checkpoint create abandoned side branches. The real conversation is
  the path from the newest leaf back to the root. Reading lines top-to-bottom
  includes dead branches — you MUST walk parent pointers. (Measured: one 222-line
  file had 29 leaves / 28 branch points and only 135 of 172 chained events on the
  active path; a 17MB file had 11,934 events but only 1,749 active.)
- **Only `user` and `assistant` events carry an API `message`.** Everything else is
  UI/metadata never sent to the model: `attachment`, `system`, `mode`,
  `permission-mode`, `file-history-snapshot`, `ai-title`, `last-prompt`,
  `queue-operation`, `pr-link`.
- **A tool call spans 3+ lines:** `assistant`(tool_use block) → `attachment` →
  `user`(tool_result block, also mirrored in a top-level `toolUseResult`). Editing
  must keep `tool_use` ↔ `tool_result` paired (this is what broke `frozenCompact`).
- Claude's own compaction appears as `user` events with `isCompactSummary: true` —
  both a template to copy and a collision risk (two compactors fighting).

## What needs to be built

### 0. Read-only analysis — ✅ SHIPPED
- `aap analyze-claude <session-id|path> [--strip-tools A,B] [--json]`
- Walks the active leaf → root path (not line order), reconstructs the API message
  array, reports tokens / cache usage / tokens-by-tool / largest results, and
  projects savings per strategy. Pure dry-run, never writes.
- Code: `src/analyze/claude-transcript.ts`, `src/cli/analyze-claude.ts`.

### 1. JSONL path discovery — approach chosen
- **Use `claude --session-id <uuid>`** (verified to exist): `aap run claude`
  generates the UUID, passes it in, and knows the exact JSONL path up front.
  No scanning, no heuristics, no stdout parsing needed.
- Path = `~/.claude/projects/<slug(cwd)>/<uuid>.jsonl` where `slug` replaces `/`
  and `.` with `-` (implemented in `projectSlug()`).
- Store AAP session-id → JSONL path in session metadata.

### 2. JSONL read + token estimation — ✅ core shipped in Phase 0
- Walk `parentUuid → uuid` from the newest leaf to root (tree, not log).
- Reconstruct the `user`/`assistant` message array; estimate tokens, or read the
  real `usage` fields off assistant events.
- `parseTranscript()` / `computeStats()` in `claude-transcript.ts`.

### 3. JSONL compaction (write-back) — applies at RESUME only

> Prerequisite: a **byte-identical round-trip harness** — `read → tree model →
> write` that reproduces the file exactly when no transform is applied, across all
> real session files. Must preserve tree structure, uuids, every event type, and
> ordering. This is the corruption firewall before any real write.

When accumulated tokens exceed threshold, at a load boundary:
- Compute compaction boundary on the active path (fold old messages, keep tail),
  re-chaining `parentUuid`/`uuid` correctly.
- Apply strategies (chosen: `stableTruncate`, `dedup`, `pruneStale`, a
  frozenCompact-style summary mirroring Claude's own `isCompactSummary` event, and
  **tool removal** for rarely-used tools like `Workflow` that failed to strip in
  the proxy). Keep `tool_use` ↔ `tool_result` pairs intact.
- Write atomically: `.jsonl.tmp` → validate re-parse + chain integrity → backup to
  `.jsonl.bak` → rename.
- Guard: refuse to write if the file's mtime moved recently (Claude is active) —
  compaction only runs when Claude is NOT running the session.

### 4. Timing: when to compact — ONLY at load boundaries
Mid-session edits do nothing (Claude ignores the file until reload) and race with
its flush, so the only valid moments are when Claude loads the file:
- **On session resume:** `aap run claude --resume <id>` (or `aap run` relaunching a
  session) → compact the existing JSONL *before* the first request. That first
  request is a full cache write regardless, so shrinking the prefix first is free.
- **On resume detection:** if `aap run` starts and an existing JSONL for the session
  has grown past threshold, compact before launch.
- **NOT on a token threshold mid-session** — there is no way to make Claude adopt the
  edit without a reload, and forcing a reload (kill + relaunch) is disruptive for
  interactive use and only sensible headless.

### 5. OpenCode support
- OpenCode doesn't use JSONL files. It uses `~/.config/opencode/` with a different format.
- Need to discover and support OpenCode's storage format separately.
- For now, JSONL compaction is Claude-only.

### 6. Read-only analysis first (safety) — ✅ SHIPPED
```
aap analyze-claude <session-id|path.jsonl> [--strip-tools A,B] [--json]
```
- Reads Claude's JSONL, reconstructs the active-path message array (tree walk).
- Reports: structure (active vs abandoned events), message count, estimated tokens,
  real cache read/write tokens, tokens-by-tool, largest results, and projected
  savings per strategy.
- Dry-run: no writes, no risk. Validates the parser on real files before any write.

### 7. Benchmark: prove it works

Current `iterative-fix-ab.sh` compares `--no-optimize` vs `--optimize` (proxy flags).
Need a new benchmark that compares:

```
Baseline:   aap run claude                    (raw, no compaction)
Wrapper:    aap run claude --compact-jsonl     (JSONL compaction enabled)
```

Metrics to compare:
- Requests per session (should be same — same task)
- Input tokens, cached tokens, cost
- Cache hit ratio (should be HIGHER with wrapper)
- Task success rate (verify=pass — compaction must not break the agent)

The A/B should run against the `iterative-fix-plus` fixture with Claude Code on
DeepSeek (not Bedrock — DeepSeek is where we can measure cache destruction). Because
the effect lands only at reload, the benchmark must compare **resumed** sessions:
run the task, resume with vs without compaction, and measure the first-post-resume
write plus subsequent reads.

### 8. Why this works AT A RESUME BOUNDARY (and why proxy rewriting failed)

Previous `iterative-fix-ab.sh` results:
- Baseline: 41 requests, 985K input (984K cached = 99.9% hit), $0.0102 cost
- Optimize: 23 requests, 770K input (732K cached = 95% hit), $0.0363 cost (3.5x MORE)

The optimize run was worse because `frozenCompact` broke the cache (tool message
pairing destroyed the prefix match) and `tailTruncate` caused non-deterministic
output (same input, different bytes each turn → cache rebuild).

JSONL compaction avoids the proxy's problem — but **only across a reload**:
- Compact the file ONCE, while Claude is NOT running the session.
- On `--resume`, Claude reads the compacted file and rebuilds from it.
- From that point Claude re-sends the compacted history every turn (it now owns it)
  → the prefix is stable → cache reads everywhere.
- The one-time cost is the cache write on the first post-resume request — which was
  going to be a full write anyway (a reload always re-primes the cache), so
  shrinking the prefix first is effectively free.
- Net savings = (reduction per turn) × (turns after resume) − (nothing extra, the
  write was unavoidable).
- **The catch:** it is NOT a permanent one-time change. Claude reclaims the stack
  after resume (appends, auto-compacts, re-emits from memory), so the benefit lasts
  until the next thing Claude does to history; sustaining it means re-compacting at
  each subsequent load boundary. And it cannot be applied transparently mid-session.
