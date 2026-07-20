import { describe, expect, it } from "vitest";
import { analyzeIdleGaps } from "./idle-gaps.js";

function ts(
  iso: string,
  cc = 0,
): { session_id: string; started_at: string; cache_creation_tokens: number } {
  return { session_id: "s1", started_at: iso, cache_creation_tokens: cc };
}

describe("analyzeIdleGaps", () => {
  it("returns empty for no data", () => {
    const result = analyzeIdleGaps([]);
    expect(result.totalGaps).toBe(0);
    expect(result.sessionsAnalyzed).toBe(0);
  });

  it("skips sessions with <2 requests", () => {
    const result = analyzeIdleGaps([ts("2024-01-01T00:00:00Z")]);
    expect(result.totalGaps).toBe(0);
  });

  it("buckets a sub-5-minute gap", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z"),
      ts("2024-01-01T00:03:00Z"),
    ]);
    expect(result.totalGaps).toBe(1);
    expect(result.globalBuckets.find((b) => b.bucket === "<5m")?.count).toBe(1);
  });

  it("buckets a 5m–1h gap", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z"),
      ts("2024-01-01T00:30:00Z"),
    ]);
    expect(result.globalBuckets.find((b) => b.bucket === "5m-1h")?.count).toBe(
      1,
    );
  });

  it("buckets a >1h gap", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z"),
      ts("2024-01-01T02:00:00Z"),
    ]);
    expect(result.globalBuckets.find((b) => b.bucket === ">1h")?.count).toBe(1);
  });

  it("computes median of gaps", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z"),
      ts("2024-01-01T00:01:00Z"),
      ts("2024-01-01T00:03:00Z"),
      ts("2024-01-01T00:06:00Z"),
    ]);
    expect(result.sessions[0]!.medianGapMs).toBe(120000); // (1min + 3min) / 2
  });

  it("computes p90 of gaps", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z"),
      ts("2024-01-01T00:01:00Z"),
      ts("2024-01-01T00:02:00Z"),
      ts("2024-01-01T00:03:00Z"),
      ts("2024-01-01T00:04:00Z"),
      ts("2024-01-01T00:05:00Z"),
      ts("2024-01-01T00:06:00Z"),
      ts("2024-01-01T00:07:00Z"),
      ts("2024-01-01T00:08:00Z"),
      ts("2024-01-01T00:09:00Z"),
      ts("2024-01-01T00:10:00Z"),
    ]);
    const p90 = result.sessions[0]!.p90GapMs;
    expect(p90).toBe(60000);
  });

  it("handles multiple sessions", () => {
    const result = analyzeIdleGaps([
      {
        session_id: "s1",
        started_at: "2024-01-01T00:00:00Z",
        cache_creation_tokens: 0,
      },
      {
        session_id: "s1",
        started_at: "2024-01-01T00:03:00Z",
        cache_creation_tokens: 0,
      },
      {
        session_id: "s2",
        started_at: "2024-01-01T01:00:00Z",
        cache_creation_tokens: 0,
      },
      {
        session_id: "s2",
        started_at: "2024-01-01T02:00:00Z",
        cache_creation_tokens: 0,
      },
    ]);
    expect(result.sessionsAnalyzed).toBe(2);
    expect(result.totalGaps).toBe(2);
  });

  it("accumulates cold-refresh cache write tokens for gaps >5min", () => {
    const result = analyzeIdleGaps([
      ts("2024-01-01T00:00:00Z", 100),
      ts("2024-01-01T00:01:00Z", 0), // <5min gap, 0 tokens (warm cache)
      ts("2024-01-01T00:10:00Z", 500), // >5min gap, 500 tokens written
      ts("2024-01-01T00:11:00Z", 0), // <5min gap, 0 tokens
    ]);
    expect(result.coldRefreshTokens).toBe(500); // only the 3rd request had a cold gap
  });
});
