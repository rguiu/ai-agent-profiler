// Hidden reference tests for the `add-methods` task. This file lives OUTSIDE the
// fixture tree (benchmarks/reference/iterative-fix-plus/) so the agent can't read
// the answer key; run.sh copies it into test/ only at grade time.
//
// Assertions are deliberately decoupled from the fixture's planted bugs:
//   - merge is checked via toArray()/size (toArray sorts by priority, so it is
//     independent of the bubbleUp bug),
//   - peekWait lives in rate-limiter.js which has no planted bug,
//   - topKeys reads access counts, independent of the get()/eviction bugs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "../src/priority-queue.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { ResultCache } from "../src/result-cache.js";

describe("PriorityQueue.merge", () => {
  it("merges all entries preserving priority order", () => {
    const a = new PriorityQueue();
    a.push("A", 1);
    a.push("C", 3);
    const b = new PriorityQueue();
    b.push("B", 2);
    b.push("D", 4);

    a.merge(b);
    assert.deepEqual(a.toArray(), ["A", "B", "C", "D"]);
    assert.equal(a.size, 4);
  });

  it("leaves the other queue unchanged and returns this", () => {
    const a = new PriorityQueue();
    a.push("A", 1);
    const b = new PriorityQueue();
    b.push("B", 2);
    b.push("C", 3);

    const ret = a.merge(b);
    assert.equal(ret, a, "merge should return this");
    assert.equal(b.size, 2, "other queue must not be mutated");
    assert.deepEqual(b.toArray(), ["B", "C"]);
  });

  it("handles merging an empty queue", () => {
    const a = new PriorityQueue();
    a.push("A", 1);
    a.merge(new PriorityQueue());
    assert.equal(a.size, 1);
    assert.deepEqual(a.toArray(), ["A"]);
  });
});

describe("RateLimiter.peekWait", () => {
  it("returns 0 when enough tokens are available and does not consume", () => {
    const rl = new RateLimiter(2, 4); // burst 4
    assert.equal(rl.peekWait(3), 0);
    assert.equal(rl.peekWait(4), 0);
    assert.equal(rl.available, 4, "peekWait must not consume tokens");
  });

  it("returns a positive wait once tokens are drained", () => {
    const rl = new RateLimiter(2, 4); // refill 0.002 tokens/ms
    for (let i = 0; i < 4; i++) rl.tryAcquire();
    const before = rl.available;
    const wait = rl.peekWait(1);
    assert.ok(wait > 0, `expected a positive wait, got ${wait}`);
    assert.ok(rl.available >= before, "peekWait must not consume tokens");
  });
});

describe("ResultCache.topKeys", () => {
  it("returns the most-accessed keys, most first", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a");
    cache.get("a");
    cache.get("a");
    cache.get("b");

    assert.deepEqual(cache.topKeys(2), ["a", "b"]);
    assert.deepEqual(cache.topKeys(1), ["a"]);
  });

  it("returns at most n keys and never more than the cache size", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    const top = cache.topKeys(5);
    assert.equal(top.length, 2);
    assert.equal(top[0], "a");
  });
});
