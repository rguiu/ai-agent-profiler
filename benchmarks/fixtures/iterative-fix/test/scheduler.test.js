import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";

describe("Scheduler", () => {
  it("runs tasks in priority order", async () => {
    const order = [];
    const s = new Scheduler({ maxConcurrency: 1 });
    s.add({ id: "low", fn: () => order.push("low"), priority: 10 });
    s.add({ id: "high", fn: () => order.push("high"), priority: 1 });
    s.add({ id: "mid", fn: () => order.push("mid"), priority: 5 });
    await s.run();
    assert.deepEqual(order, ["high", "mid", "low"]);
  });

  it("respects dependencies", async () => {
    const order = [];
    const s = new Scheduler({ maxConcurrency: 4 });
    s.add({ id: "a", fn: () => order.push("a"), priority: 5 });
    s.add({ id: "b", fn: () => order.push("b"), priority: 1, deps: ["a"] });
    s.add({ id: "c", fn: () => order.push("c"), priority: 1, deps: ["b"] });
    await s.run();
    const aIdx = order.indexOf("a");
    const bIdx = order.indexOf("b");
    const cIdx = order.indexOf("c");
    assert.ok(aIdx < bIdx, `"a" must run before "b" (got ${aIdx} vs ${bIdx})`);
    assert.ok(bIdx < cIdx, `"b" must run before "c" (got ${bIdx} vs ${cIdx})`);
  });

  it("retries failed tasks up to maxRetries", async () => {
    let attempts = 0;
    const s = new Scheduler({ maxConcurrency: 1 });
    s.add({
      id: "flaky",
      maxRetries: 3,
      fn: () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
      },
    });
    const result = await s.run();
    assert.equal(attempts, 3);
    assert.ok(result.completed.includes("flaky"));
    assert.equal(result.failed.length, 0);
  });

  it("marks tasks as failed after exhausting retries", async () => {
    const s = new Scheduler({ maxConcurrency: 1 });
    s.add({
      id: "doomed",
      maxRetries: 2,
      fn: () => {
        throw new Error("always fails");
      },
    });
    const result = await s.run();
    assert.ok(result.failed.includes("doomed"));
    assert.equal(result.completed.length, 0);
  });

  it("retries preserve original priority", async () => {
    const order = [];
    const s = new Scheduler({ maxConcurrency: 1 });
    let failOnce = true;
    s.add({
      id: "retryable",
      priority: 1,
      maxRetries: 2,
      fn: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("once");
        }
        order.push("retryable");
      },
    });
    s.add({ id: "normal", priority: 5, fn: () => order.push("normal") });
    await s.run();
    assert.deepEqual(order, ["retryable", "normal"]);
  });

  it("emits lifecycle events", async () => {
    const events = [];
    const s = new Scheduler({ maxConcurrency: 1 });
    s.bus.on("task:started", (e) => events.push(`start:${e.id}`));
    s.bus.on("task:completed", (e) => events.push(`done:${e.id}`));
    s.add({ id: "x", fn: () => {} });
    await s.run();
    assert.ok(events.includes("start:x"));
    assert.ok(events.includes("done:x"));
  });

  it("cancel removes queued task", async () => {
    const ran = [];
    const s = new Scheduler({ maxConcurrency: 1 });
    s.add({
      id: "a",
      fn: async () => {
        ran.push("a");
        await new Promise((r) => setTimeout(r, 50));
      },
    });
    s.add({ id: "b", fn: () => ran.push("b") });
    // Cancel b before it starts
    s.cancel("b");
    await s.run();
    assert.deepEqual(ran, ["a"]);
  });

  it("handles concurrent tasks up to maxConcurrency", async () => {
    let peak = 0;
    let current = 0;
    const s = new Scheduler({ maxConcurrency: 3 });
    for (let i = 0; i < 6; i++) {
      s.add({
        id: `t${i}`,
        fn: async () => {
          current++;
          peak = Math.max(peak, current);
          await new Promise((r) => setTimeout(r, 20));
          current--;
        },
      });
    }
    await s.run();
    assert.ok(peak <= 3, `Peak concurrency ${peak} exceeds max 3`);
    assert.ok(peak >= 2, `Expected some concurrency, got peak ${peak}`);
  });
});
