export interface GapBucket {
  bucket: "<5m" | "5m-1h" | ">1h";
  count: number;
  percent: number;
}

export interface SessionIdleGaps {
  sessionId: string;
  requestCount: number;
  gaps: number;
  buckets: GapBucket[];
  medianGapMs: number;
  p90GapMs: number;
}

export interface IdleGapsResult {
  totalGaps: number;
  sessionsAnalyzed: number;
  globalBuckets: GapBucket[];
  sessions: SessionIdleGaps[];
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function bucketLabel(ms: number): GapBucket["bucket"] {
  if (ms < FIVE_MIN_MS) return "<5m";
  if (ms <= ONE_HOUR_MS) return "5m-1h";
  return ">1h";
}

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function p90(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.9) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function analyzeIdleGaps(
  rows: Array<{ session_id: string; started_at: string }>,
): IdleGapsResult {
  const bySession = new Map<string, string[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push(row.started_at);
    bySession.set(row.session_id, list);
  }

  const sessions: SessionIdleGaps[] = [];
  const globalCounts: Record<GapBucket["bucket"], number> = {
    "<5m": 0,
    "5m-1h": 0,
    ">1h": 0,
  };
  let totalGaps = 0;
  let sessionsWithGaps = 0;

  for (const [sessionId, timestamps] of bySession) {
    if (timestamps.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      const prev = new Date(timestamps[i - 1]!).getTime();
      const curr = new Date(timestamps[i]!).getTime();
      gaps.push(curr - prev);
    }
    if (gaps.length === 0) continue;
    sessionsWithGaps++;
    totalGaps += gaps.length;

    const sessionCounts: Record<GapBucket["bucket"], number> = {
      "<5m": 0,
      "5m-1h": 0,
      ">1h": 0,
    };
    for (const ms of gaps) {
      const bucket = bucketLabel(ms);
      sessionCounts[bucket]++;
      globalCounts[bucket]++;
    }

    const sorted = [...gaps].sort((a, b) => a - b);
    sessions.push({
      sessionId,
      requestCount: timestamps.length,
      gaps: gaps.length,
      buckets: [
        {
          bucket: "<5m",
          count: sessionCounts["<5m"],
          percent: pct(sessionCounts["<5m"], gaps.length),
        },
        {
          bucket: "5m-1h",
          count: sessionCounts["5m-1h"],
          percent: pct(sessionCounts["5m-1h"], gaps.length),
        },
        {
          bucket: ">1h",
          count: sessionCounts[">1h"],
          percent: pct(sessionCounts[">1h"], gaps.length),
        },
      ],
      medianGapMs: median(sorted),
      p90GapMs: p90(sorted),
    });
  }

  sessions.sort((a, b) => b.gaps - a.gaps);

  return {
    totalGaps,
    sessionsAnalyzed: sessionsWithGaps,
    globalBuckets: [
      {
        bucket: "<5m",
        count: globalCounts["<5m"],
        percent: pct(globalCounts["<5m"], totalGaps),
      },
      {
        bucket: "5m-1h",
        count: globalCounts["5m-1h"],
        percent: pct(globalCounts["5m-1h"], totalGaps),
      },
      {
        bucket: ">1h",
        count: globalCounts[">1h"],
        percent: pct(globalCounts[">1h"], totalGaps),
      },
    ],
    sessions,
  };
}
