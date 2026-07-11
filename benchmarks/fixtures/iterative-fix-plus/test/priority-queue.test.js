import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PriorityQueue } from "../src/priority-queue.js";

describe("PriorityQueue", () => {
  it("pops items in priority order", () => {
    const pq = new PriorityQueue();
    pq.push("low", 10);
    pq.push("high", 1);
    pq.push("mid", 5);
    assert.equal(pq.pop(), "high");
    assert.equal(pq.pop(), "mid");
    assert.equal(pq.pop(), "low");
  });

  it("maintains heap invariant with many inserts", () => {
    const pq = new PriorityQueue();
    const items = [7, 3, 9, 1, 5, 8, 2, 6, 4, 10];
    items.forEach((n, i) => pq.push(`item-${n}`, n));
    const result = [];
    for (let guard = 0; !pq.isEmpty(); guard++) {
      assert.ok(guard < items.length, "pop() did not drain the queue (heap/pop is broken)");
      result.push(pq.pop());
    }
    assert.deepEqual(
      result,
      items.sort((a, b) => a - b).map((n) => `item-${n}`),
    );
  });

  it("handles duplicate priorities correctly", () => {
    const pq = new PriorityQueue();
    pq.push("a", 5);
    pq.push("b", 5);
    pq.push("c", 1);
    assert.equal(pq.pop(), "c");
    // both a and b have same priority, either order is fine
    const rest = [pq.pop(), pq.pop()].sort();
    assert.deepEqual(rest, ["a", "b"]);
  });

  it("peek does not remove", () => {
    const pq = new PriorityQueue();
    pq.push("x", 3);
    pq.push("y", 1);
    assert.equal(pq.peek(), "y");
    assert.equal(pq.size, 2);
  });

  it("remove works and maintains order", () => {
    const pq = new PriorityQueue();
    pq.push("a", 1);
    pq.push("b", 2);
    pq.push("c", 3);
    pq.push("d", 4);
    assert.equal(pq.remove("b"), true);
    assert.equal(pq.size, 3);
    assert.equal(pq.pop(), "a");
    assert.equal(pq.pop(), "c");
    assert.equal(pq.pop(), "d");
  });

  it("updatePriority changes extraction order", () => {
    const pq = new PriorityQueue();
    pq.push("a", 10);
    pq.push("b", 5);
    pq.push("c", 8);
    pq.updatePriority("a", 1); // promote "a" to highest
    assert.equal(pq.pop(), "a");
    assert.equal(pq.pop(), "b");
    assert.equal(pq.pop(), "c");
  });

  it("toArray returns sorted items", () => {
    const pq = new PriorityQueue();
    pq.push("z", 9);
    pq.push("a", 1);
    pq.push("m", 5);
    assert.deepEqual(pq.toArray(), ["a", "m", "z"]);
  });

  it("stress test with 100 random insertions", () => {
    const pq = new PriorityQueue();
    const priorities = Array.from({ length: 100 }, (_, i) => i + 1);
    // Shuffle
    for (let i = priorities.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [priorities[i], priorities[j]] = [priorities[j], priorities[i]];
    }
    priorities.forEach((p) => pq.push(`item-${p}`, p));
    let prev = -1;
    for (let guard = 0; !pq.isEmpty(); guard++) {
      assert.ok(guard < 100, "pop() did not drain the queue (heap/pop is broken)");
      const item = pq.pop();
      const num = parseInt(item.split("-")[1]);
      assert.ok(num > prev, `Expected ${num} > ${prev}`);
      prev = num;
    }
  });
});
