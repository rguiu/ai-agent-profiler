import { describe, expect, it } from "vitest";
import {
  turnCache,
  commonPrefixTokens,
  estimateTokens,
  CACHE_BLOCK_TOKENS,
} from "./cache-cost.js";

describe("cache-cost", () => {
  describe("commonPrefixTokens", () => {
    it("floors the shared prefix to a 64-token storage unit", () => {
      const prefix = "a".repeat(64 * 4);
      const a = prefix + "xxxx";
      const b = prefix + "yyyy";
      expect(commonPrefixTokens(a, b)).toBe(64);
    });

    it("returns 0 when the shared prefix is under one unit", () => {
      const a = "a".repeat(63 * 4) + "x";
      const b = "a".repeat(63 * 4) + "y";
      expect(commonPrefixTokens(a, b)).toBe(0);
    });

    it("returns 0 for a divergence at position 0", () => {
      expect(commonPrefixTokens("abc", "xyz")).toBe(0);
    });
  });

  describe("turnCache", () => {
    it("treats a cold prefix as all miss", () => {
      const prompt = "z".repeat(CACHE_BLOCK_TOKENS * 4 * 2);
      const tc = turnCache(null, prompt);
      expect(tc.hitTokens).toBe(0);
      expect(tc.missTokens).toBe(estimateTokens(prompt));
    });

    it("counts an identical prompt as (almost) all hit", () => {
      const prompt = "z".repeat(CACHE_BLOCK_TOKENS * 4 * 4);
      const tc = turnCache(prompt, prompt);
      // Floored to a 64-token unit, so hit is within one block of full.
      expect(tc.hitTokens).toBeGreaterThanOrEqual(
        tc.promptTokens - CACHE_BLOCK_TOKENS,
      );
      expect(tc.hitTokens + tc.missTokens).toBe(tc.promptTokens);
    });

    it("an append-only change keeps the whole prior prefix cached", () => {
      const base = "p".repeat(CACHE_BLOCK_TOKENS * 4 * 3);
      const appended = base + "q".repeat(CACHE_BLOCK_TOKENS * 4);
      const tc = turnCache(base, appended);
      expect(tc.hitTokens).toBe(estimateTokens(base));
      expect(tc.missTokens).toBe(estimateTokens(appended) - estimateTokens(base));
    });

    it("an early edit forfeits nearly the entire prefix", () => {
      const tail = "t".repeat(CACHE_BLOCK_TOKENS * 4 * 10);
      const prev = "SYSTEM-A" + tail;
      const current = "SYSTEM-B" + tail;
      const tc = turnCache(prev, current);
      expect(tc.hitTokens).toBe(0);
      expect(tc.missTokens).toBe(tc.promptTokens);
    });
  });
});
