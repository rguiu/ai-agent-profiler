// Prefix-stability classifier (see docs/PREFIX-FINGERPRINTING.md). Given a
// session's requests ordered by started_at, diffs each adjacent pair of
// prefix fingerprints to determine whether the cached prefix survived
// (append-only) or was invalidated (rewrite), and — on a rewrite — names the
// first broken segment in prefix order: system, tools, then the lowest
// diverging message index.

export interface PrefixInput {
  requestId: string;
  systemHash: string | null;
  toolsHash: string | null;
  messageHashes: string[];
  messageCount: number | null;
}

export type BrokenSegment = "system" | "tools" | `message[${number}]`;

export type PrefixTransition =
  | { kind: "first" }
  | { kind: "append-only" }
  | { kind: "rewrite"; brokenSegment: BrokenSegment };

export interface PrefixStabilityResult {
  requestId: string;
  transition: PrefixTransition;
}

export interface PrefixStabilitySummary {
  requests: number;
  longestStableRun: number;
  breakPoints: string[];
  dominantBreakSegment: BrokenSegment | null;
}

function commonPrefixLen(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// Classify one transition given the previous and current prefix fingerprint.
// `prev === null` marks the first request in the session — not a break.
export function classifyPrefixTransition(
  prev: PrefixInput | null,
  cur: PrefixInput,
): PrefixTransition {
  if (prev === null) return { kind: "first" };

  const prevHashes = prev.messageHashes;
  const curHashes = cur.messageHashes;
  const prevCount = prev.messageCount ?? prevHashes.length;
  const common = commonPrefixLen(prevHashes, curHashes);

  const systemChanged = prev.systemHash !== cur.systemHash;
  const toolsChanged = prev.toolsHash !== cur.toolsHash;
  const appendOnly = common === prevCount && !systemChanged && !toolsChanged;

  if (appendOnly) return { kind: "append-only" };

  // First broken segment, checked in prefix order: system -> tools -> message[i].
  let brokenSegment: BrokenSegment;
  if (systemChanged) {
    brokenSegment = "system";
  } else if (toolsChanged) {
    brokenSegment = "tools";
  } else {
    brokenSegment = `message[${common}]`;
  }
  return { kind: "rewrite", brokenSegment };
}

// Classify a whole session's timeline (ordered by started_at). Returns one
// result per request (the first is always `{ kind: "first" }`).
export function analyzePrefixStability(
  inputs: PrefixInput[],
): PrefixStabilityResult[] {
  const results: PrefixStabilityResult[] = [];
  let prev: PrefixInput | null = null;
  for (const cur of inputs) {
    results.push({
      requestId: cur.requestId,
      transition: classifyPrefixTransition(prev, cur),
    });
    prev = cur;
  }
  return results;
}

// Session-level summary: longest run of consecutive append-only transitions
// (the "stable run" the cache actually benefited from), the request ids where
// a rewrite broke the prefix, and the segment most often responsible.
export function summarizePrefixStability(
  results: PrefixStabilityResult[],
): PrefixStabilitySummary {
  let longestStableRun = 0;
  let currentRun = 0;
  const breakPoints: string[] = [];
  const segmentCounts = new Map<BrokenSegment, number>();

  for (const result of results) {
    if (result.transition.kind === "append-only") {
      currentRun++;
      longestStableRun = Math.max(longestStableRun, currentRun);
    } else if (result.transition.kind === "rewrite") {
      currentRun = 0;
      breakPoints.push(result.requestId);
      const segment = result.transition.brokenSegment;
      segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
    } else {
      // "first" doesn't extend or break a run.
      currentRun = 0;
    }
  }

  let dominantBreakSegment: BrokenSegment | null = null;
  let dominantCount = 0;
  for (const [segment, count] of segmentCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantBreakSegment = segment;
    }
  }

  return {
    requests: results.length,
    longestStableRun,
    breakPoints,
    dominantBreakSegment,
  };
}
