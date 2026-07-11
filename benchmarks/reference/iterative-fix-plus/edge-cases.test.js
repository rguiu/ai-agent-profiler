// Hidden edge-case tests. Lives OUTSIDE the fixture tree so the agent never
// sees the test. Run along with methods.test.js at verify time.
//
// These test edge cases the existing suite misses — partial/wrong fixes that
// happen to pass the basic tests will fail here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { PriorityQueue } from "../src/priority-queue.js";
import { RateLimiter } from "../src/rate-limiter.js";
import { ResultCache } from "../src/result-cache.js";
import { Scheduler } from "../src/scheduler.js";
import { Pipeline } from "../src/pipeline.js";
import { EventBus } from "../src/event-bus.js";

// Run a scheduler scenario in a worker thread so a *synchronous* busy-loop in
// Scheduler.run() (a real bug: spinning when a task's deps can never be
// satisfied, or when a ready task is parked without progress) can be
// force-terminated. An in-process setTimeout/Promise.race guard cannot
// interrupt a synchronous loop — the event loop never yields — so without this
// the whole `node --test` process hangs and gets SIGKILLed, zeroing every test.
//
// `tasks` is a list of serialisable specs: { id, deps?, priority?, maxRetries?,
// failTimes? }. Each task's fn posts its id when it runs; `failTimes` makes it
// throw the first N runs (to exercise retry). Returns { ran, started, completed }
// where `completed` is false if the scheduler had to be terminated for hanging.
function runSchedulerInWorker(schedulerUrl, tasks, timeoutMs = 3000) {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(${JSON.stringify(schedulerUrl)}).then(async ({ Scheduler }) => {
      const s = new Scheduler({ maxConcurrency: 1 });
      const fails = {};
      if (s.bus && s.bus.on) s.bus.on("task:started", (e) => parentPort.postMessage({ type: "started", id: e.id }));
      for (const t of workerData.tasks) {
        s.add({
          id: t.id,
          deps: t.deps ?? [],
          priority: t.priority,
          maxRetries: t.maxRetries,
          fn: () => {
            if (t.failTimes && (fails[t.id] = (fails[t.id] || 0) + 1) <= t.failTimes) throw new Error("fail");
            parentPort.postMessage({ type: "ran", id: t.id });
          },
        });
      }
      await s.run();
      parentPort.postMessage({ type: "done" });
    }).catch((e) => parentPort.postMessage({ type: "error", message: String(e) }));
  `;
  return new Promise((resolve) => {
    const ran = [];
    const started = [];
    const w = new Worker(code, { eval: true, workerData: { tasks } });
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      resolve({ ran, started, completed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    w.on("message", (m) => {
      if (m.type === "ran") ran.push(m.id);
      else if (m.type === "started") started.push(m.id);
      else if (m.type === "done" || m.type === "error") finish(true);
    });
    w.on("error", () => finish(true));
  });
}

// ── BUG #1: PriorityQueue bubbleUp uses Math.floor(i/2) not (i-1)/2 ──────

describe("PriorityQueue — bubbleUp edge cases", () => {
  it("maintains heap with chained insertions at specific indices", () => {
    const pq = new PriorityQueue();
    // Push values chosen to expose the off-by-one in bubbleUp.
    // After the buggy fix, some bubble-up paths compute the wrong parent.
    pq.push("a", 10);
    pq.push("b", 9);
    pq.push("c", 8);
    pq.push("d", 7);
    pq.push("e", 6);
    pq.push("f", 5);
    pq.push("g", 4);
    pq.push("h", 3);
    const result = [];
    // Bounded drain: a broken heap must fail here, not spin forever.
    for (let guard = 0; !pq.isEmpty(); guard++) {
      assert.ok(
        guard < 8,
        "pop() did not drain the queue (heap/pop is broken)",
      );
      result.push(pq.pop());
    }
    assert.deepEqual(result, ["h", "g", "f", "e", "d", "c", "b", "a"]);
  });

  it("heap invariant holds after many insertions (100 items)", () => {
    const pq = new PriorityQueue();
    for (let i = 100; i >= 1; i--) pq.push(`v${i}`, i);
    let prev = 0;
    for (let guard = 0; !pq.isEmpty(); guard++) {
      assert.ok(
        guard < 100,
        "pop() did not drain the queue (heap/pop is broken)",
      );
      const item = pq.pop();
      const n = parseInt(item.slice(1), 10);
      assert.ok(n >= prev, `out of order: ${n} < ${prev}`);
      prev = n;
    }
  });

  it("heap invariant holds after complex interleaved push/pop", () => {
    const pq = new PriorityQueue();
    pq.push("a", 5);
    pq.push("b", 3);
    assert.equal(pq.pop(), "b");
    pq.push("c", 1);
    pq.push("d", 4);
    assert.equal(pq.pop(), "c");
    pq.push("e", 2);
    assert.equal(pq.pop(), "e");
    assert.equal(pq.pop(), "d");
    assert.equal(pq.pop(), "a");
    assert.equal(pq.size, 0);
  });
});

// ── merge edge cases ──────────────────────────────────────────────────────

describe("PriorityQueue.merge — edge cases", () => {
  it("merge with duplicate priorities preserves stability", () => {
    const a = new PriorityQueue();
    a.push("a1", 1);
    a.push("a2", 3);
    const b = new PriorityQueue();
    b.push("b1", 1);
    b.push("b2", 3);
    b.push("b3", 2);
    a.merge(b);
    assert.equal(a.size, 5);
    // All items must be present
    const all = new Set(a.toArray());
    assert.equal(all.size, 5);
    assert.ok(all.has("a1"));
    assert.ok(all.has("a2"));
    assert.ok(all.has("b1"));
    assert.ok(all.has("b2"));
    assert.ok(all.has("b3"));
  });

  it("merged queue still respects heap after further operations", () => {
    const a = new PriorityQueue();
    a.push("a", 10);
    const b = new PriorityQueue();
    b.push("b", 5);
    b.push("c", 1);
    a.merge(b);
    // After merge, pop order should be correct
    assert.equal(a.pop(), "c");
    assert.equal(a.pop(), "b");
    // Push more and verify heap order continues
    a.push("d", 3);
    a.push("e", 0);
    assert.equal(a.pop(), "e");
    assert.equal(a.pop(), "d");
    assert.equal(a.pop(), "a");
  });

  it("merge the queue with itself is a no-op on size", () => {
    const pq = new PriorityQueue();
    pq.push("x", 1);
    pq.push("y", 2);
    // A correct merge snapshots `other`'s entries first. A naive impl that
    // iterates other.#heap while pushing into it will grow unboundedly when
    // other === this — detect that and fail fast instead of hanging/OOMing.
    const before = pq.size;
    let guard = 0;
    const origPush = pq.push.bind(pq);
    pq.push = (item, priority) => {
      if (++guard > before * 4) {
        throw new Error(
          "merge(self) grew unboundedly — must snapshot entries before pushing",
        );
      }
      return origPush(item, priority);
    };
    try {
      pq.merge(pq);
    } finally {
      pq.push = origPush;
    }
    assert.equal(pq.size, 2);
  });

  it("merge large queue into small one works correctly", () => {
    const small = new PriorityQueue();
    small.push("s", 100);
    const large = new PriorityQueue();
    for (let i = 0; i < 50; i++) large.push(`l${i}`, i);
    small.merge(large);
    assert.equal(small.size, 51);
    let prev = -1;
    // Verify full heap order by popping all (bounded so a broken merge/heap fails)
    for (let guard = 0; !small.isEmpty(); guard++) {
      assert.ok(
        guard < 51,
        "pop() did not drain the queue (merge/heap is broken)",
      );
      const item = small.pop();
      const n = item.startsWith("s") ? 100 : parseInt(item.slice(1), 10);
      assert.ok(n >= prev, `out of order: ${n} < ${prev}`);
      prev = n;
    }
  });

  it("merge leaves other queue as independent copy", () => {
    const a = new PriorityQueue();
    a.push("a", 1);
    const b = new PriorityQueue();
    b.push("b", 2);
    a.merge(b);
    // Modify b after merge
    b.push("b2", 0);
    // a should NOT see b2
    assert.equal(a.size, 2);
    assert.deepEqual(a.toArray(), ["a", "b"]);
  });
});

// ── BUG #2: Scheduler deps check inverted ─────────────────────────────────

describe("Scheduler — dependency edge cases", () => {
  it("blocks task until ALL deps complete (not just one)", async () => {
    // Run in a worker: a buggy scheduler can synchronously busy-loop when a
    // task's deps aren't all satisfied, which an in-process await cannot
    // interrupt. The worker guard turns that hang into a clean failure.
    const schedulerUrl = new URL("../src/scheduler.js", import.meta.url).href;
    const { ran, completed } = await runSchedulerInWorker(
      schedulerUrl,
      [
        { id: "a", priority: 1 },
        { id: "b", priority: 1 },
        { id: "c", deps: ["a", "b"], priority: 2 },
      ],
      3000,
    );
    assert.ok(completed, "scheduler busy-looped instead of draining tasks");
    const aIdx = ran.indexOf("a");
    const bIdx = ran.indexOf("b");
    const cIdx = ran.indexOf("c");
    assert.ok(cIdx !== -1, `"c" must run once its deps complete`);
    assert.ok(aIdx < cIdx, `"a" must run before "c"`);
    assert.ok(bIdx < cIdx, `"b" must run before "c"`);
  });

  it("task with no deps runs immediately", async () => {
    const s = new Scheduler({ maxConcurrency: 1 });
    let ran = false;
    s.add({
      id: "x",
      fn: () => {
        ran = true;
      },
      deps: [],
    });
    await s.run();
    assert.ok(ran);
  });

  it("task with a dep on a non-existent task never runs while others proceed", async () => {
    // The scheduler may legitimately never terminate here (orphan can never be
    // unblocked). What it must NOT do is (a) run the orphan, or (b) starve the
    // ready task 'other'. A correct fix drains 'other' then either exits or
    // parks orphan without busy-spinning. We run in a worker so a synchronous
    // spin-loop is force-terminated instead of hanging the whole test process.
    const schedulerUrl = new URL("../src/scheduler.js", import.meta.url).href;
    const { ran, completed } = await runSchedulerInWorker(
      schedulerUrl,
      [
        { id: "orphan", deps: ["nonexistent"], priority: 1 },
        { id: "other", priority: 2 },
      ],
      3000,
    );
    // The valid task must have run (whether or not run() ever returned).
    assert.ok(ran.includes("other"), "unblocked task 'other' should have run");
    assert.ok(!ran.includes("orphan"), "orphan task must not have run");
    // A synchronous busy-loop that never yields is a bug: 'other' would never
    // even get a chance to run, and the process would need force-termination.
    // If we had to terminate AND 'other' never ran, that's the busy-loop bug.
    assert.ok(
      completed || ran.includes("other"),
      "scheduler busy-looped synchronously without draining ready tasks",
    );
  });
});

// ── BUG #3: Scheduler retry loses priority ────────────────────────────────

describe("Scheduler — retry priority edge cases", () => {
  it("retried task keeps its original priority relative to others", async () => {
    const order = [];
    const s = new Scheduler({ maxConcurrency: 1 });
    let failCount = 0;
    s.add({
      id: "high-prio-retry",
      priority: 1,
      maxRetries: 3,
      fn: () => {
        failCount++;
        if (failCount <= 2) throw new Error("fail");
        order.push("high-prio-retry");
      },
    });
    s.add({
      id: "low-prio",
      priority: 10,
      fn: () => order.push("low-prio"),
    });
    await s.run();
    // High-priority should run before low-priority despite retries
    assert.equal(order[0], "high-prio-retry");
    assert.equal(order.length, 2);
  });

  it("retry after multiple failures still uses original priority", async () => {
    const s = new Scheduler({ maxConcurrency: 1 });
    let failCount = 0;
    s.add({
      id: "a",
      priority: 5,
      maxRetries: 5,
      fn: () => {
        failCount++;
        if (failCount < 5) throw new Error("fail");
      },
    });
    s.add({ id: "b", priority: 1, fn: () => {} });
    const order = [];
    s.bus.on("task:started", (e) => order.push(e.id));
    await s.run();
    // b (priority 1) should run before a's retries (priority 5)
    assert.equal(order[0], "b");
  });
});

// ── BUG #4: EventBus history trimming keeps oldest ────────────────────────

describe("EventBus — history edge cases", () => {
  it("history keeps the most recent events after exceeding max", () => {
    const bus = new EventBus({ maxHistory: 3 });
    for (let i = 0; i < 10; i++) bus.emit("tick", i);
    const h = bus.history(10);
    assert.equal(h.length, 3, "should keep at most maxHistory events");
    // Most recent should be 9, 8, 7
    assert.equal(h[0].data, 9);
    assert.equal(h[1].data, 8);
    assert.equal(h[2].data, 7);
  });

  it("history with maxHistory=1 always has exactly the latest event", () => {
    const bus = new EventBus({ maxHistory: 1 });
    bus.emit("first", 1);
    bus.emit("second", 2);
    bus.emit("third", 3);
    const h = bus.history();
    assert.equal(h.length, 1);
    assert.equal(h[0].data, 3);
  });

  it("history after clear is empty", () => {
    const bus = new EventBus();
    bus.emit("a", 1);
    bus.emit("b", 2);
    bus.clear();
    assert.equal(bus.history().length, 0);
  });
});

// ── BUG #6: ResultCache.get returns entry object ──────────────────────────

describe("ResultCache — get return-value edge cases", () => {
  it("get returns null when stored value is null", () => {
    const cache = new ResultCache();
    cache.set("k", null);
    assert.equal(cache.get("k"), null);
  });

  it("get returns 0 when stored value is 0", () => {
    const cache = new ResultCache();
    cache.set("k", 0);
    assert.equal(cache.get("k"), 0);
  });

  it("get returns false when stored value is false", () => {
    const cache = new ResultCache();
    cache.set("k", false);
    assert.equal(cache.get("k"), false);
  });

  it("get returns empty string when stored value is empty string", () => {
    const cache = new ResultCache();
    cache.set("k", "");
    assert.equal(cache.get("k"), "");
  });

  it("get returns the value, not a metadata wrapper", () => {
    const cache = new ResultCache();
    cache.set("k", { x: 42 });
    const result = cache.get("k");
    // If bug #6 is present, result would be the entry { value, expiresAt, ... }
    // not { x: 42 }
    assert.equal(typeof result, "object");
    assert.equal(result.x, 42);
    assert.equal(result.expiresAt, undefined, "should not leak expiresAt");
    assert.equal(result.accessCount, undefined, "should not leak accessCount");
  });

  it("get returns undefined for expired entries even after previous access", async () => {
    const cache = new ResultCache(10, 20);
    cache.set("k", "val");
    assert.equal(cache.get("k"), "val");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cache.get("k"), undefined);
  });
});

// ── BUG #7: ResultCache evicts MRU instead of LRU ─────────────────────────

describe("ResultCache — LRU eviction edge cases", () => {
  it("evicts the least-recently-used entry, not the most", () => {
    const cache = new ResultCache(2, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    // Access "a" so "b" becomes LRU
    cache.get("a");
    // Now add "c" — should evict "b" (LRU), not "a" (MRU)
    cache.set("c", 3);
    assert.equal(cache.has("a"), true, "'a' should survive (was MRU)");
    assert.equal(cache.has("b"), false, "'b' should be evicted (was LRU)");
    assert.equal(cache.has("c"), true);
  });

  it("eviction order is correct with interleaved access", () => {
    const cache = new ResultCache(3, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // a=MRU, b=LRU
    cache.get("b"); // b=MRU, c=LRU
    cache.set("d", 4); // should evict c
    assert.equal(cache.has("c"), false);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), true);
  });

  it("getOrCompute bumps LRU position", async () => {
    const cache = new ResultCache(2, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    await cache.getOrCompute("a", async () => "fresh");
    // Now b is LRU
    cache.set("c", 3);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), false);
  });
});

// ── BUG #8: Pipeline context overwrites instead of merging ────────────────

describe("Pipeline — context accumulation edge cases", () => {
  it("context from earlier stages is visible in later stages", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("s1", [{ id: "a", fn: async () => "first" }]);
    p.addStage("s2", [
      { id: "b", fn: async (ctx) => ({ ...ctx, added: "second" }) },
    ]);
    p.addStage("s3", [
      {
        id: "c",
        fn: async (ctx) => {
          // Both s1.a and s2.b results should be in context
          return { hasA: ctx.a === "first", hasB: ctx.added === "second" };
        },
      },
    ]);
    const result = await p.run();
    assert.equal(result.c.hasA, true, "stage 3 should see stage 1 result");
    assert.equal(result.c.hasB, true, "stage 3 should see stage 2 result");
  });

  it("getContext returns accumulated state mid-pipeline", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    let captured = null;
    p.addStage("s1", [
      {
        id: "x",
        fn: async () => {
          captured = p.getContext();
          return "done";
        },
      },
    ]);
    await p.run({ initial: "yes" });
    assert.equal(captured.initial, "yes");
  });
});

// ── RateLimiter.peekWait edge cases ────────────────────────────────────────

describe("RateLimiter.peekWait — edge cases", () => {
  it("peekWait(0) returns 0", () => {
    const rl = new RateLimiter(10, 5);
    assert.equal(rl.peekWait(0), 0);
  });

  it("peekWait with n > burst returns a positive wait", () => {
    const rl = new RateLimiter(10, 3);
    const wait = rl.peekWait(5);
    assert.ok(wait > 0, `expected positive wait for n > burst, got ${wait}`);
  });

  it("peekWait does not consume tokens after repeated calls", () => {
    const rl = new RateLimiter(100, 10);
    const before = rl.available;
    rl.peekWait(1);
    rl.peekWait(1);
    rl.peekWait(5);
    assert.equal(rl.available, before, "peekWait must be idempotent");
  });

  it("peekWait accounts for refill over time", async () => {
    const rl = new RateLimiter(100, 2); // 100/sec = 0.1 tokens/ms
    // Drain
    rl.tryAcquire();
    rl.tryAcquire();
    const waitBefore = rl.peekWait(1);
    await new Promise((r) => setTimeout(r, 50));
    const waitAfter = rl.peekWait(1);
    assert.ok(
      waitAfter < waitBefore,
      `wait should decrease after refill: ${waitAfter} >= ${waitBefore}`,
    );
  });
});

// ── ResultCache.topKeys edge cases ─────────────────────────────────────────

describe("ResultCache.topKeys — edge cases", () => {
  it("topKeys(0) returns empty array", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.get("a");
    assert.deepEqual(cache.topKeys(0), []);
  });

  it("topKeys with n > cache size returns all keys", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    const top = cache.topKeys(100);
    assert.equal(top.length, 2);
  });

  it("topKeys excludes expired entries", async () => {
    const cache = new ResultCache(10, 20);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.get("a");
    cache.get("b");
    await new Promise((r) => setTimeout(r, 30));
    // Both are expired, cache still has them until pruned but topKeys should skip
    const top = cache.topKeys(10);
    assert.equal(
      top.length,
      0,
      `expired entries should not appear, got ${top}`,
    );
  });

  it("topKeys returns keys sorted by access count descending", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("x", 1);
    cache.set("y", 2);
    cache.set("z", 3);
    cache.get("y");
    cache.get("y");
    cache.get("y"); // y = 3
    cache.get("z");
    cache.get("z"); // z = 2
    cache.get("x"); // x = 1
    assert.deepEqual(cache.topKeys(3), ["y", "z", "x"]);
  });

  it("topKeys handles ties in access counts", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // All have accessCount = 0 (never get'd)
    const top = cache.topKeys(3);
    assert.equal(top.length, 3);
    // All keys present, order unspecified for ties
    const set = new Set(top);
    assert.deepEqual(set, new Set(["a", "b", "c"]));
  });

  it("topKeys does not mutate cache state", () => {
    const cache = new ResultCache(10, 60000);
    cache.set("a", 1);
    cache.get("a");
    const sizeBefore = cache.size;
    cache.topKeys(1);
    assert.equal(cache.size, sizeBefore);
    assert.equal(cache.has("a"), true);
  });
});

// ── Cross-module integration edge cases ────────────────────────────────────

describe("Integration — cross-module", () => {
  it("Scheduler uses PriorityQueue correctly under load", async () => {
    const s = new Scheduler({ maxConcurrency: 3 });
    const completed = [];
    for (let i = 0; i < 20; i++) {
      s.add({
        id: `t${i}`,
        priority: 20 - i,
        fn: async () => {
          await new Promise((r) => setTimeout(r, 5));
          completed.push(`t${i}`);
        },
      });
    }
    await s.run();
    assert.equal(completed.length, 20);
  });

  it("Pipeline preserves context across many stages", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    // 5 stages that each add one key
    for (let i = 1; i <= 5; i++) {
      p.addStage(`s${i}`, [
        { id: `v${i}`, fn: async (ctx) => ({ ...ctx, [`k${i}`]: i }) },
      ]);
    }
    const result = await p.run({ k0: 0 });
    assert.equal(result.v5.k0, 0);
    assert.equal(result.v5.k1, 1);
    assert.equal(result.v5.k2, 2);
    assert.equal(result.v5.k3, 3);
    assert.equal(result.v5.k4, 4);
  });

  it("EventBus history survives scheduler run with many events", async () => {
    const bus = new EventBus({ maxHistory: 50 });
    const s = new Scheduler({ maxConcurrency: 4 });
    // Use the scheduler's own bus by constructing differently...
    // Actually just test that a bus with small maxHistory works under emit load
    for (let i = 0; i < 200; i++) bus.emit("tick", i);
    const h = bus.history(10);
    assert.equal(h.length, 10);
    // Most recent 10 events should be 199 down to 190
    for (let i = 0; i < 10; i++) {
      assert.equal(h[i].data, 199 - i);
    }
  });
});
