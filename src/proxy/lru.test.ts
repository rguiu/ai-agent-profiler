import { describe, expect, it } from "vitest";
import { LruMap } from "./lru.js";

describe("LruMap", () => {
  it("evicts the least-recently-used entry past the cap", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3); // evicts "a"
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
    expect(lru.size).toBe(2);
  });

  it("refreshes recency on get so touched keys survive", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // "a" now most-recent
    lru.set("c", 3); // evicts "b", not "a"
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });

  it("overwriting an existing key updates value without growing size", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("a", 9);
    expect(lru.get("a")).toBe(9);
    expect(lru.size).toBe(1);
  });

  it("rejects a non-positive cap", () => {
    expect(() => new LruMap<string, number>(0)).toThrow();
  });
});
