import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  it("allows burst of requests up to capacity", () => {
    const limiter = new RateLimiter(10, 5);
    let acquired = 0;
    for (let i = 0; i < 10; i++) {
      if (limiter.tryAcquire()) acquired++;
    }
    assert.equal(acquired, 5); // burst capacity is 5
  });

  it("refills tokens over time", async () => {
    const limiter = new RateLimiter(100, 2); // 100/sec, burst 2
    // Exhaust burst
    assert.ok(limiter.tryAcquire());
    assert.ok(limiter.tryAcquire());
    assert.equal(limiter.tryAcquire(), false);

    // Wait 30ms → should have ~3 tokens (100/sec = 0.1/ms, 30ms = 3 tokens)
    await new Promise((r) => setTimeout(r, 35));
    assert.ok(limiter.tryAcquire());
  });

  it("acquire waits when no tokens available", async () => {
    const limiter = new RateLimiter(50, 1); // 50/sec, burst 1
    limiter.tryAcquire(); // exhaust
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 15, `Expected >=15ms wait, got ${elapsed}ms`);
    assert.ok(elapsed < 100, `Wait too long: ${elapsed}ms`);
  });

  it("execute rate-limits function calls", async () => {
    const limiter = new RateLimiter(20, 3);
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await limiter.execute(() => i * 2));
    }
    assert.deepEqual(results, [0, 2, 4]);
  });

  it("reset restores full capacity", () => {
    const limiter = new RateLimiter(10, 5);
    for (let i = 0; i < 5; i++) limiter.tryAcquire();
    assert.equal(limiter.tryAcquire(), false);
    limiter.reset();
    assert.ok(limiter.tryAcquire());
  });

  it("acquireMany gets multiple tokens", async () => {
    const limiter = new RateLimiter(100, 10);
    await limiter.acquireMany(5);
    assert.equal(limiter.available, 5);
  });

  it("rejects acquireMany exceeding burst", async () => {
    const limiter = new RateLimiter(10, 3);
    await assert.rejects(
      () => limiter.acquireMany(5),
      /Cannot acquire 5 tokens/,
    );
  });
});
