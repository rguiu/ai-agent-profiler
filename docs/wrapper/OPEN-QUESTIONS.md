# Open questions for the Claude Code / Claude users community

Context: we're building a profiling proxy + wrapper around Claude Code (`aap`) that
tries to reduce prompt-cache waste. The central obstacle is that Claude Code rebuilds
each API request from its own in-memory conversation state every turn, so proxy-side
edits to the request body are "undone" on the next turn (the client re-sends pristine
history → cache rebuild). We verified (empirically on macOS + Claude Code docs) that
the only way to make Claude adopt an edited conversation is to edit the transcript
JSONL on disk and then reload it via `--resume`.

These are the questions we could not answer ourselves and want to ask the community.
The first is the most important.

---

## 1. Can the request stack be rewritten _outside_ of `--resume`? (headline)

We want a proxy/wrapper to shrink the conversation Claude Code sends upstream (to keep
the prompt cache warm) and have the change **persist across turns**. What we found:
during a live session Claude holds the conversation in memory and only _appends_ to
the transcript JSONL; the transcript file is written asynchronously and lags the
in-memory state. The only path we found to make Claude adopt an edited transcript is
to kill the process and relaunch with `--resume`.

**Ask:** Is there _any_ runtime mechanism to make a running Claude Code re-read /
rebuild its conversation from disk mid-session — a signal, IPC, a hook that forces a
reload, a debug/dev flag, an undocumented command? Or does anything let the outgoing
request body be permanently altered without the client re-sending pristine history the
next turn?

## 2. Is there a hook that can _rewrite_ (not just block) history or compaction?

`PreCompact` appears to only allow/deny compaction; `FileChanged` reacts to file
changes but does not trigger a reload. Hooks receive `transcript_path` but we found no
way for a hook to mutate the transcript and have Claude honor it on the current turn.

**Ask:** Can any hook modify the transcript, the compaction result, or the outgoing
request, and have Claude honor that change on the current turn (not just on a later
reload)?

## 3. Is the transcript's "active leaf" always the last physical line?

The transcript JSONL is a tree (`parentUuid → uuid`) with abandoned branches created
by rewind / edit / checkpoint. We reconstruct the active conversation by walking from
the newest leaf back to the root, and we currently assume the active conversation ends
at the last physical line that has a `uuid`.

**Ask:** After a rewind or `--resume`, can an event on an _abandoned_ branch ever be
the last physical line in the file? Is there a documented field (e.g. `leafUuid`,
`timestamp`) that authoritatively identifies the active leaf, so we don't have to rely
on physical line order?

## 4. Is the transcript JSONL schema documented and stable across versions?

We reverse-engineered the event types on our machine: `user`, `assistant`,
`attachment`, `system`, `mode`, `permission-mode`, `file-history-snapshot`,
`ai-title`, `last-prompt`, `queue-operation`, `pr-link`, plus flags like
`isCompactSummary`, `isSidechain`, and the top-level `toolUseResult`. Only `user` and
`assistant` events carry an API `message`; a tool call spans an `assistant`(tool_use)
event and a later `user`(tool_result) event.

**Ask:** Is there an official specification for this format? How often does it change
between Claude Code versions, and is there a version field we should gate on before
parsing or editing?

## 5. 1-hour prompt cache — is the `ttl:"1h"` rewrite actually honored on Bedrock?

The Anthropic prompt-caching docs say the 1-hour cache TTL needs no beta header (just
`cache_control: {type:"ephemeral", ttl:"1h"}`) and is supported on Amazon Bedrock. We
rewrite Claude Code's 5-minute markers to 1h in our proxy, but we have **not** confirmed
a real cache _hit_ after a 6-minute idle gap on Bedrock in `eu-west-1` — only that the
request is accepted.

**Ask:** Has anyone verified the 1h TTL is genuinely honored on Bedrock (a cache read,
not a rebuild, after >5 min idle), as opposed to the field being silently accepted and
ignored? Any region-specific caveats?

## 6. Keep-alive pings — legitimacy and effectiveness

We can replay the last request during idle (e.g. with `max_tokens` minimal) to keep the
prompt-cache prefix warm before its TTL expires.

**Ask:** Is proactively pinging to keep a prompt cache alive an acceptable use pattern?
Does a replayed request reliably reset the cache TTL, or does the backend treat such
pings differently? Any guidance on avoiding surprising quota/billing effects?

## 7. Does editing the transcript + `--resume` risk corruption or trip integrity checks?

We plan to edit the transcript JSONL while Claude is stopped, then relaunch with
`--resume`. We write atomically (temp file → validate re-parse + chain integrity →
backup → rename).

**Ask:** Does Claude Code validate the transcript on load (chain integrity, checksums,
signatures)? Will a well-formed but externally-edited transcript load cleanly, or is
there a guard that rejects transcripts it didn't write itself?

---

_Background and the verified constraints behind these questions are in
`docs/optimization/PLAN.md` (see "What is possible vs. not") and
`docs/wrapper/CLAUDE-JSONL.md` (see the "VERIFIED REALITY" box)._
