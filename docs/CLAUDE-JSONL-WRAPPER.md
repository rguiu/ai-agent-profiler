# Claude JSONL wrapper — what needs to be built

The core idea: instead of proxy-side request rewriting (which destroys cache because
the client re-sends pristine history next turn), the wrapper modifies Claude's local
conversation JSONL files. Claude stores the optimized history and re-sends it
identically every turn — cache stays coherent.

## What we know about Claude's JSONL

**Path:** `~/.claude/projects/<project-hash>/<session-uuid>.jsonl`
**Format:** One JSON line per event. Types: `user`, `assistant`, `permission-mode`.
Messages have `{ role, content }` matching the API format.

Discovered on this system:
- Project hash: `-Users-raulguiugallardo-Projects-aitools-ai-agent-profiler`
- Session UUIDs: `039d4c07-...`, `27936296-...`, `a9807f43-...`
- A 249-line session file contained user messages with `role: "user"` and
  assistant messages with `content: [{ type: "tool_use", name: "Bash", ... }]`

## What needs to be built

### 1. JSONL path discovery
- `aap run claude` must find the session's JSONL path before spawning Claude
- Options:
  - a) Launch Claude with `--session-id <uuid>` so we know the UUID in advance
  - b) Scan `~/.claude/projects/<cwd-hash>/` for the newest JSONL after launch
  - c) Have Claude report its session UUID via stdout (custom instruction?)
- Store the mapping: AAP session-id → JSONL path in session metadata

### 2. JSONL read + token estimation
- Parse the JSONL, extract `message` objects, reconstruct the full message array
- Estimate accumulated tokens (chars/4 or use a proper tokenizer)
- This tells us when compaction is needed (e.g., >80K tokens)

### 3. JSONL compaction (write-back)
When accumulated tokens exceed threshold:
- Compute compaction boundary (fold old messages, keep tail)
- Apply strategies to each message:
  - `stableTruncate`: truncate large tool results (deterministic, content-addressed)
  - `shapeTestOutput`: strip passing-test spam from test output
  - `stripTools`: remove tool definitions never called
  - `pruneStale`: replace old tool results with compact summaries
  - `pruneUnusedTools`: drop tool defs from the tools array
  - `collapseSystem`: replace repeated system prompts with hash stubs
  - `dedup`: replace identical repeated tool results with stubs
  - `suppressReread`: remove reads of files just written
- Write compacted JSONL atomically:
  1. Write to `.jsonl.tmp`
  2. Validate parseable (read back and verify)
  3. Backup original to `.jsonl.bak`
  4. Rename `.jsonl.tmp` → `.jsonl`
- Locking: check file mtime — if Claude wrote since we last read, abort and retry

### 4. Timing: when to compact
- **On token threshold:** accumulated estimated tokens > N (configurable, default 80K)
- **Wait for completed request:** compaction must happen BETWEEN Claude requests, not
  mid-request when Claude is reading/writing the JSONL
- Detection: track JSONL mtime — a request is "complete" when mtime hasn't changed
  for >500ms and the last line is an assistant message (not user)
- **On session resume:** if `aap run` detects an existing JSONL for the session, compact
  immediately before first request (the first request is always a cache write)

### 5. OpenCode support
- OpenCode doesn't use JSONL files. It uses `~/.config/opencode/` with a different format.
- Need to discover and support OpenCode's storage format separately.
- For now, JSONL compaction is Claude-only.

### 6. Read-only analysis first (safety)
Before writing to JSONL files, build a read-only analysis tool:
```
aap analyze --claude-session <session-id>
```
- Reads Claude's JSONL
- Reports: message count, estimated tokens, what compaction WOULD save
- Dry-run: no writes, no risk
- This validates the approach before implementing writes

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
DeepSeek (not Bedrock — DeepSeek is where we can measure cache destruction).

### 8. Why this should work (where proxy rewriting failed)

Previous `iterative-fix-ab.sh` results:
- Baseline: 41 requests, 985K input (984K cached = 99.9% hit), $0.0102 cost
- Optimize: 23 requests, 770K input (732K cached = 95% hit), $0.0363 cost (3.5x MORE)

The optimize run was worse because `frozenCompact` broke the cache (tool message
pairing destroyed the prefix match) and `tailTruncate` caused non-deterministic
output (same input, different bytes each turn → cache rebuild).

With JSONL compaction:
- Compaction happens ONCE, between requests
- Claude stores the compacted version permanently
- Claude re-sends identical bytes every turn
- The prefix is genuinely stable → cache reads everywhere
- The one-time cost is the cache write on the turn after compaction
- All subsequent turns are pure cache reads at the compacted size
- Net savings = (reduction per turn) × (turns after compaction) - (one write cost)
