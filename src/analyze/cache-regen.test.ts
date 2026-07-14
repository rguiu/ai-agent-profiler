import { describe, expect, it } from "vitest";
import {
  classifyRegen,
  detectRegenerations,
  type RegenPoint,
} from "./cache-regen.js";

const pt = (over: Partial<RegenPoint>): RegenPoint => ({
  id: "r",
  startedAt: "2026-07-12T10:00:00Z",
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  ...over,
});

describe("classifyRegen", () => {
  it("never flags the first request (expected cold start)", () => {
    const r = classifyRegen(null, pt({ inputTokens: 200000 }));
    expect(r.cold).toBe(false);
  });

  it("does not flag a healthy append-only turn", () => {
    const prev = pt({ cachedInputTokens: 50000, inputTokens: 500 });
    // Next turn: reads the 50k prefix, adds a small new turn.
    const cur = pt({ cachedInputTokens: 50500, inputTokens: 400 });
    expect(classifyRegen(prev, cur).cold).toBe(false);
  });

  it("flags a TTL-expiry regeneration after an idle gap", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 120000,
      inputTokens: 300,
    });
    // 20 minutes later, the whole prefix is re-written (cache expired).
    const cur = pt({
      startedAt: "2026-07-12T10:20:00Z",
      cacheCreationInputTokens: 120000,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur);
    expect(r.cold).toBe(true);
    expect(r.severity).toBe("high");
    expect(r.reason).toMatch(/idle/);
    expect(r.excessTokens).toBeGreaterThan(50000);
  });

  it("flags a prefix change when tokens are written mid-session, no idle gap", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 40000,
      inputTokens: 300,
    });
    // 10s later: 40k written to cache beyond new content (prefix edited).
    const cur = pt({
      startedAt: "2026-07-12T10:00:10Z",
      cacheCreationInputTokens: 40000,
      cachedInputTokens: 0,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur);
    expect(r.cold).toBe(true);
    expect(r.reason).toMatch(/prefix changed/);
  });

  it("ignores small excess below the floor", () => {
    const prev = pt({ cachedInputTokens: 10000, inputTokens: 100 });
    const cur = pt({ cachedInputTokens: 10000, inputTokens: 2000 });
    expect(classifyRegen(prev, cur).cold).toBe(false);
  });
});

describe("classifyRegen with prefix transition data", () => {
  it("attributes a rewrite transition to recap/prefix-edit and names the segment", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 40000,
      inputTokens: 300,
    });
    const cur = pt({
      startedAt: "2026-07-12T10:00:10Z",
      cacheCreationInputTokens: 40000,
      cachedInputTokens: 0,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur, {
      prefixTransition: { kind: "rewrite", brokenSegment: "tools" },
    });
    expect(r.cold).toBe(true);
    expect(r.reason).toMatch(/tools/);
    expect(r.reason).toMatch(/recap or prefix-edit/);
  });

  it("attributes an append-only transition beyond the TTL to TTL expiry", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 120000,
      inputTokens: 300,
    });
    const cur = pt({
      startedAt: "2026-07-12T10:20:00Z",
      cacheCreationInputTokens: 120000,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur, {
      prefixTransition: { kind: "append-only" },
    });
    expect(r.cold).toBe(true);
    expect(r.reason).toMatch(/idle/);
  });

  it("attributes an append-only transition within the TTL to a plain cache miss", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 40000,
      inputTokens: 300,
    });
    const cur = pt({
      startedAt: "2026-07-12T10:00:10Z",
      cacheCreationInputTokens: 40000,
      cachedInputTokens: 0,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur, {
      prefixTransition: { kind: "append-only" },
    });
    expect(r.cold).toBe(true);
    expect(r.reason).toMatch(/cache miss/);
    expect(r.reason).not.toMatch(/idle/);
  });

  it("falls back to the gap-only heuristic when no prefix transition is passed", () => {
    const prev = pt({
      startedAt: "2026-07-12T10:00:00Z",
      cachedInputTokens: 120000,
      inputTokens: 300,
    });
    const cur = pt({
      startedAt: "2026-07-12T10:20:00Z",
      cacheCreationInputTokens: 120000,
      inputTokens: 300,
    });
    const r = classifyRegen(prev, cur);
    expect(r.cold).toBe(true);
    expect(r.reason).toMatch(/idle/);
  });
});

describe("detectRegenerations", () => {
  it("returns only the cold turns, keyed by id", () => {
    const points: RegenPoint[] = [
      pt({ id: "a", inputTokens: 100000 }), // cold start, not flagged
      pt({ id: "b", cachedInputTokens: 100000, inputTokens: 400 }), // healthy
      pt({
        id: "c",
        startedAt: "2026-07-12T11:00:00Z",
        cacheCreationInputTokens: 100000,
        inputTokens: 400,
      }), // regen
    ];
    const map = detectRegenerations(points);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(true);
  });

  it("does not let a metric-less request reset the baseline", () => {
    const points: RegenPoint[] = [
      pt({ id: "a", cachedInputTokens: 80000, inputTokens: 300 }),
      pt({ id: "gap", inputTokens: null, cachedInputTokens: null }),
      pt({ id: "b", cachedInputTokens: 80500, inputTokens: 300 }),
    ];
    const map = detectRegenerations(points);
    expect(map.has("b")).toBe(false);
  });

  it("uses the prefixTransitions map to attribute each regeneration deterministically", () => {
    const points: RegenPoint[] = [
      pt({ id: "a", cachedInputTokens: 40000, inputTokens: 300 }),
      pt({
        id: "b",
        startedAt: "2026-07-12T10:00:10Z",
        cacheCreationInputTokens: 40000,
        cachedInputTokens: 0,
        inputTokens: 300,
      }),
    ];
    const prefixTransitions = new Map<
      string,
      { kind: "rewrite"; brokenSegment: "system" }
    >([["b", { kind: "rewrite", brokenSegment: "system" }]]);
    const map = detectRegenerations(points, { prefixTransitions });
    expect(map.get("b")?.reason).toMatch(/system/);
  });
});
