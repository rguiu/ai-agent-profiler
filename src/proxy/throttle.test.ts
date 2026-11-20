import { describe, expect, it } from "vitest";
import { Throttle } from "./throttle.js";

describe("Throttle", () => {
  it("allows requests up to maxConcurrent immediately", async () => {
    const t = new Throttle({ maxConcurrent: 3, maxQueued: 10, timeoutMs: 100 });
    await t.acquire();
    await t.acquire();
    await t.acquire();
    expect(t.inflight).toBe(3);
    expect(t.pending).toBe(0);
  });

  it("queues requests beyond maxConcurrent and releases them", async () => {
    const t = new Throttle({
      maxConcurrent: 1,
      maxQueued: 10,
      timeoutMs: 1000,
    });
    await t.acquire();

    let resolved = false;
    const p = t.acquire().then(() => {
      resolved = true;
    });

    expect(t.pending).toBe(1);
    expect(resolved).toBe(false);

    t.release();
    await p;
    expect(resolved).toBe(true);
  });

  it("rejects with backpressure when queue is full", async () => {
    const t = new Throttle({ maxConcurrent: 1, maxQueued: 1, timeoutMs: 1000 });
    await t.acquire();
    // This goes into the queue (size 1)
    const _queued = t.acquire();

    // This should reject — queue is full
    await expect(t.acquire()).rejects.toThrow("backpressure");
    t.release();
    t.release();
    await _queued;
  });

  it("times out queued requests", async () => {
    const t = new Throttle({ maxConcurrent: 1, maxQueued: 10, timeoutMs: 50 });
    await t.acquire();

    await expect(t.acquire()).rejects.toThrow("timed out");
    t.release();
  });

  it("drains queue in FIFO order", async () => {
    const t = new Throttle({
      maxConcurrent: 1,
      maxQueued: 10,
      timeoutMs: 1000,
    });
    await t.acquire();

    const order: number[] = [];
    const p1 = t.acquire().then(() => order.push(1));
    const p2 = t.acquire().then(() => order.push(2));

    t.release();
    await p1;
    t.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  it("reports inflight, queue depth and the oldest wait", async () => {
    const t = new Throttle({
      maxConcurrent: 1,
      maxQueued: 10,
      timeoutMs: 1000,
    });
    await t.acquire();
    const queued = t.acquire();
    await new Promise((r) => setTimeout(r, 30));

    const stats = t.stats();
    expect(stats.inflight).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.oldestQueuedMs).toBeGreaterThanOrEqual(20);
    expect(stats.maxConcurrent).toBe(1);

    t.release();
    await queued;
    expect(t.stats().queued).toBe(0);
  });

  it("drops a waiter when its client signal aborts", async () => {
    const t = new Throttle({
      maxConcurrent: 1,
      maxQueued: 10,
      timeoutMs: 60_000,
    });
    await t.acquire();

    const abort = new AbortController();
    const queued = t.acquire(abort.signal);
    expect(t.pending).toBe(1);

    abort.abort();
    await expect(queued).rejects.toThrow("aborted");
    // The place is gone immediately, not at the queue timeout.
    expect(t.pending).toBe(0);

    // And the slot handoff goes to the next request, not the dead one.
    const next = t.acquire();
    t.release();
    await next;
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const t = new Throttle({
      maxConcurrent: 1,
      maxQueued: 10,
      timeoutMs: 1000,
    });
    const abort = new AbortController();
    abort.abort();
    await expect(t.acquire(abort.signal)).rejects.toThrow("aborted");
    expect(t.inflight).toBe(0);
  });
});
