# Prefix fingerprinting & stability

Prompt-cache cost on Anthropic/Bedrock is governed by the **prefix**: identical
leading tokens hit the cache (~0.1x input); the first request whose prefix
differs pays a cache **write** (1.25x, or 2x on the 1h TTL). So the two questions
that matter for optimizing a cache-first agent like Claude Code are:

1. **Was a cache-write a recap/prefix-rewrite, or an unavoidable TTL expiry?**
   (The `cache-regen` analyzer can't currently tell — it guesses from the idle
   gap. See findings #9/#10 in the review.)
2. **What broke the prefix?** (system prompt changed, tool defs reordered, a
   message rewritten by compaction.)

Both are answerable *deterministically from the captured request bytes* — the
proxy already sees every full request body. This layer fingerprints the prefix
segments per request and diffs consecutive requests within a session.

## What gets fingerprinted

Computed at parse time (the request body is already decoded in
`parseRequestBody`, `src/parse/parse.ts`). For each request:

- `system_hash` — stable hash of the concatenated system-prompt text.
- `tools_hash` — stable hash of the canonicalized tool-definitions array.
  Order-sensitive on purpose: Claude Code sends tools in a stable order, and a
  reorder is a genuine cache break.
- `message_hashes` — an ordered array with one hash per message, hashed on the
  message's role + content. Stored as a JSON array.

Hashing is content-only (no timestamps), so identical prefixes across requests
produce identical hashes. A short, fast non-crypto hash (FNV-1a) is sufficient —
we only need equality, not collision resistance against adversaries.

## Storage

A new table keyed by request, populated during `aap parse`:

```sql
CREATE TABLE request_prefix (
  request_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  system_hash    TEXT,
  tools_hash     TEXT,
  message_hashes TEXT,   -- JSON array of per-message hashes, in order
  message_count  INTEGER
);
```

Added via the existing `ensureColumn`/idempotent-schema migration pattern in
`src/store/store.ts` — never a destructive migration.

## The stability classifier

`src/analyze/prefix-stability.ts`. Given a session's requests ordered by
`started_at`, for each adjacent pair `(prev, cur)`:

1. `commonPrefixLen` = longest `k` such that
   `prev.message_hashes[0..k) === cur.message_hashes[0..k)`.
2. Classify the transition:
   - **append-only** — `commonPrefixLen === prev.message_count` AND
     `system_hash`/`tools_hash` unchanged. The cached prefix is intact; `cur`
     only added new messages. Cache-preserving.
   - **rewrite** — divergence before `prev.message_count`, or system/tools
     changed. The cached prefix is broken.
3. On a rewrite, report the **first broken segment**, checked in prefix order:
   `system` → `tools` → `message[i]` (the lowest diverging message index). This
   is the actionable output: it names *what* invalidated the cache.

## Feeding cause attribution (closes #10)

`cache-regen` currently labels a cache-write "idle expiry" purely from the gap.
With the prefix diff available it becomes deterministic:

| prefix transition | cache-write present | idle gap | attributed cause |
|---|---|---|---|
| rewrite | yes | any | **recap / prefix-edit** (`message[i]` or `tools`/`system`) |
| append-only | yes | `> effectiveTtl` | **TTL expiry** (unavoidable) |
| append-only | yes | `<= effectiveTtl` | cache miss (investigate) |

This replaces the gap-only guess with the byte-level truth, and the reported
segment tells the user whether it's fixable (self-inflicted churn) or not
(compaction / real idle).

## Reporting

Surfaced per session in the read API and `aap export`:

- prefix stability: *"stable 8 turns → broke at turn 9 in `tools` (reordered)"*.
- churn summary: how many cache-writes were recap-driven (rewrite) vs
  unavoidable (append + expired), and the dominant break segment.

## Scope / non-goals

- No message *content* is stored — only hashes. Redaction-safe by construction.
- Fingerprinting is off the hot path (parse time), like all other metrics.
- Order-sensitivity for tools is intentional; if Claude Code ever sends tools
  unordered this becomes a canonicalization step, not a redesign.
