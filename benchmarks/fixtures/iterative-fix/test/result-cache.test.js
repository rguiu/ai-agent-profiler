import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ResultCache } from "../src/result-cache.js";

describe("ResultCache", () => {
  it("stores and retrieves values", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("key1", { data: "hello" });
    const result = cache.get("key1");
    assert.deepEqual(result, { data: "hello" });
  });

  it("returns undefined for missing keys", () => {
    const cache = new ResultCache();
    assert.equal(cache.get("nope"), undefined);
  });

  it("expires entries after TTL", async () => {
    const cache = new ResultCache(10, 50); // 50ms TTL
    cache.set("ephemeral", "value");
    assert.equal(cache.get("ephemeral"), "value");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(cache.get("ephemeral"), undefined);
  });

  it("respects per-key TTL override", async () => {
    const cache = new ResultCache(10, 1000); // 1s default
    cache.set("short", "val", 30); // 30ms override
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(cache.get("short"), undefined);
  });

  it("evicts LRU when full", () => {
    const cache = new ResultCache(3, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" to make it recently used
    cache.get("a");
    // Adding "d" should evict "b" (least recently used)
    cache.set("d", 4);
    assert.equal(cache.has("a"), true);  // recently accessed
    assert.equal(cache.has("b"), false); // evicted (LRU)
    assert.equal(cache.has("c"), true);
    assert.equal(cache.has("d"), true);
  });

  it("getOrCompute caches the computed value", async () => {
    const cache = new ResultCache();
    let computeCount = 0;
    const fn = async () => { computeCount++; return 42; };
    const r1 = await cache.getOrCompute("x", fn);
    const r2 = await cache.getOrCompute("x", fn);
    assert.equal(r1, 42);
    assert.equal(r2, 42);
    assert.equal(computeCount, 1); // only computed once
  });

  it("prune removes expired entries", async () => {
    const cache = new ResultCache(10, 30);
    cache.set("a", 1);
    cache.set("b", 2);
    await new Promise((r) => setTimeout(r, 40));
    cache.set("c", 3); // still fresh
    const removed = cache.prune();
    assert.equal(removed, 2);
    assert.equal(cache.size, 1);
  });

  it("delete removes a specific entry", () => {
    const cache = new ResultCache();
    cache.set("x", "val");
    assert.equal(cache.delete("x"), true);
    assert.equal(cache.get("x"), undefined);
    assert.equal(cache.delete("x"), false);
  });

  it("stats reports correct counts", async () => {
    const cache = new ResultCache(10, 30);
    cache.set("a", 1);
    cache.set("b", 2);
    await new Promise((r) => setTimeout(r, 40));
    cache.set("c", 3);
    const s = cache.stats();
    assert.equal(s.size, 3);
    assert.equal(s.expired, 2);
    assert.equal(s.active, 1);
  });
});
