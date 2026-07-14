// Detect cold-cache regenerations across a session's request timeline.
//
// A "cold regeneration" is a turn where the provider had to (re)compute a large
// span of the prompt that it should have been able to serve from cache — i.e.
// cache tokens that were paid as WRITES or MISSES beyond what the newly-appended
// turn explains. It shows up after a TTL expiry (idle gap), or after something
// upstream changed the cached prefix.
//
// This is provider-agnostic: it works from the three token buckets each request
// reports (fresh input, cached read, cache write) plus timing.
//
// When prefix-fingerprint data is available (see
// docs/PREFIX-FINGERPRINTING.md and prefix-stability.ts), attribution becomes
// deterministic instead of gap-only guesswork: a "rewrite" transition names
// the broken segment; an "append-only" transition beyond the TTL is a real
// expiry; anything else is an unexplained cache miss. Callers that don't have
// prefix data (or pass none) keep the previous gap-based heuristic — fully
// backward-compatible.

import type { PrefixTransition } from "./prefix-stability.js";

export interface RegenPoint {
  id: string;
  startedAt: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  outputTokens: number | null;
}

export type RegenSeverity = "none" | "warn" | "high";

export interface RegenResult {
  cold: boolean;
  severity: RegenSeverity;
  // Tokens re-billed beyond what this turn's new content explains.
  excessTokens: number;
  reason: string | null;
}

// A regeneration is only meaningful above this absolute floor; below it the
// "excess" is just normal turn-to-turn jitter, not a cache event.
const EXCESS_FLOOR = 5000;
const HIGH_FLOOR = 50000;
// Idle gap (ms) beyond which the provider cache has likely expired (Anthropic
// documents "at least 5 minutes" for ephemeral entries). Used as a fallback
// when the caller doesn't pass a real effective TTL via `RegenOptions.ttlMs`.
const TTL_GAP_MS = 5 * 60 * 1000;

// Optional per-request context that sharpens attribution beyond the
// gap-only heuristic. Both fields are optional so existing callers that
// don't have this data keep working unchanged.
export interface RegenOptions {
  // Effective cache TTL (ms) for the provider/session; defaults to the
  // 5-minute floor when omitted.
  ttlMs?: number;
  // The prefix-fingerprint transition into `cur` (see prefix-stability.ts).
  // When provided, attribution becomes deterministic instead of guessed
  // from the idle gap (closes #10 — see docs/PREFIX-FINGERPRINTING.md).
  prefixTransition?: PrefixTransition;
}

function parseTs(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Classify one request given the previous one. `prev` is null for the first
// request in the session (its cold start is expected, not flagged).
export function classifyRegen(
  prev: RegenPoint | null,
  cur: RegenPoint,
  options?: RegenOptions,
): RegenResult {
  const ttlGapMs = options?.ttlMs ?? TTL_GAP_MS;
  const fresh = cur.inputTokens ?? 0;
  const write = cur.cacheCreationInputTokens ?? 0;
  const read = cur.cachedInputTokens ?? 0;

  // The first request is always a cold write — expected, don't flag.
  if (prev === null) {
    return { cold: false, severity: "none", excessTokens: 0, reason: null };
  }

  // Tokens the provider had to (re)compute this turn: fresh input + cache
  // writes. New content the agent legitimately appended is explained by the
  // growth in total prompt size; anything beyond that is a regeneration.
  const prevTotal =
    (prev.inputTokens ?? 0) +
    (prev.cachedInputTokens ?? 0) +
    (prev.cacheCreationInputTokens ?? 0);
  const curTotal = fresh + read + write;
  const growth = Math.max(0, curTotal - prevTotal);

  // Recomputed = fresh + write (everything NOT served from cache read).
  const recomputed = fresh + write;
  const excess = Math.max(0, recomputed - growth);

  if (excess < EXCESS_FLOOR) {
    return {
      cold: false,
      severity: "none",
      excessTokens: excess,
      reason: null,
    };
  }

  // Pick the most likely reason.
  const prevTs = parseTs(prev.startedAt);
  const curTs = parseTs(cur.startedAt);
  const gap = prevTs !== null && curTs !== null ? curTs - prevTs : null;

  const reason = attributeReason(
    options?.prefixTransition,
    gap,
    ttlGapMs,
    write,
    recomputed,
    excess,
  );

  return {
    cold: true,
    severity: excess >= HIGH_FLOOR ? "high" : "warn",
    excessTokens: excess,
    reason,
  };
}

// Deterministic cause attribution when a prefix transition is available;
// falls back to the previous gap-only heuristic otherwise. Per
// docs/PREFIX-FINGERPRINTING.md's table:
//   rewrite            + cache-write -> recap / prefix-edit (names the segment)
//   append-only        + gap > ttl   -> TTL expiry (unavoidable)
//   append-only        + gap <= ttl  -> cache miss (investigate)
function attributeReason(
  prefixTransition: PrefixTransition | undefined,
  gap: number | null,
  ttlGapMs: number,
  write: number,
  recomputed: number,
  excess: number,
): string {
  if (prefixTransition?.kind === "rewrite") {
    return `prefix rewritten at ${prefixTransition.brokenSegment} (recap or prefix-edit) — ${fmt(write || excess)} tokens re-billed`;
  }
  if (prefixTransition?.kind === "append-only") {
    if (gap !== null && gap >= ttlGapMs) {
      const mins = Math.round(gap / 60000);
      return `cache expired after ~${mins} min idle — prefix recomputed (${fmt(excess)} tokens re-billed)`;
    }
    return `${fmt(excess)} tokens recomputed beyond this turn's new content (cache miss on already-sent context)`;
  }

  // No prefix data available — fall back to the gap-only heuristic.
  if (gap !== null && gap >= ttlGapMs) {
    const mins = Math.round(gap / 60000);
    return `cache expired after ~${mins} min idle — prefix recomputed (${fmt(excess)} tokens re-billed)`;
  }
  if (write > 0 && write >= recomputed * 0.5) {
    return `prompt prefix changed — ${fmt(write)} tokens written to cache beyond new content`;
  }
  return `${fmt(excess)} tokens recomputed beyond this turn's new content (cache miss on already-sent context)`;
}

// Classify a whole ordered timeline; returns a map of request id → result for
// the requests that are cold regenerations (others omitted). `prefixTransitions`
// is an optional map of request id → PrefixTransition (see
// analyzePrefixStability), keyed the same as `options.prefixTransition` would
// be per-point.
export function detectRegenerations(
  points: RegenPoint[],
  options?: RegenOptions & {
    prefixTransitions?: Map<string, PrefixTransition>;
  },
): Map<string, RegenResult> {
  const out = new Map<string, RegenResult>();
  let prev: RegenPoint | null = null;
  for (const p of points) {
    const prefixTransition = options?.prefixTransitions?.get(p.id);
    const r = classifyRegen(prev, p, { ...options, prefixTransition });
    if (r.cold) out.set(p.id, r);
    // Only advance `prev` for requests that actually carry token metrics, so a
    // metric-less request (unparsed) doesn't reset the baseline.
    if (p.inputTokens !== null || p.cachedInputTokens !== null) prev = p;
  }
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
