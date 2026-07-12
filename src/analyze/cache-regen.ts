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
// documents "at least 5 minutes" for ephemeral entries).
const TTL_GAP_MS = 5 * 60 * 1000;

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
): RegenResult {
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
    return { cold: false, severity: "none", excessTokens: excess, reason: null };
  }

  // Pick the most likely reason.
  const prevTs = parseTs(prev.startedAt);
  const curTs = parseTs(cur.startedAt);
  const gap = prevTs !== null && curTs !== null ? curTs - prevTs : null;

  let reason: string;
  if (gap !== null && gap >= TTL_GAP_MS) {
    const mins = Math.round(gap / 60000);
    reason = `cache expired after ~${mins} min idle — prefix recomputed (${fmt(excess)} tokens re-billed)`;
  } else if (write > 0 && write >= recomputed * 0.5) {
    reason = `prompt prefix changed — ${fmt(write)} tokens written to cache beyond new content`;
  } else {
    reason = `${fmt(excess)} tokens recomputed beyond this turn's new content (cache miss on already-sent context)`;
  }

  return {
    cold: true,
    severity: excess >= HIGH_FLOOR ? "high" : "warn",
    excessTokens: excess,
    reason,
  };
}

// Classify a whole ordered timeline; returns a map of request id → result for
// the requests that are cold regenerations (others omitted).
export function detectRegenerations(
  points: RegenPoint[],
): Map<string, RegenResult> {
  const out = new Map<string, RegenResult>();
  let prev: RegenPoint | null = null;
  for (const p of points) {
    const r = classifyRegen(prev, p);
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
