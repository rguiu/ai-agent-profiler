// Hidden edge-case tests for SlidingWindowThrottle. Lives OUTSIDE the fixture
// tree so the agent never sees it. Copied into test/ at verify time.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowThrottle } from "../src/throttle.js";

describe("SlidingWindowThrottle — boundary condition (BUG #9)", () => {
  it("blocks requests exactly at max capacity", () => {
    const t = new SlidingWindowThrottle(2, 1000);
    assert.equal(t.isAllowed("u", 1000), true);
    assert.equal(t.isAllowed("u", 1050), true);
    assert.equal(t.isAllowed("u", 1100), false);
  });

  it("does not leak an extra request when window rolls over", () => {
    const t = new SlidingWindowThrottle(2, 1000);
    // Fill the window at t=1000
    assert.equal(t.isAllowed("u", 1000), true);
    assert.equal(t.isAllowed("u", 1000), true);
    // Third at same time should be blocked
    assert.equal(t.isAllowed("u", 1000), false);

    // A request made exactly windowMs ago is still within the window, so the
    // two earlier requests still count and the next one is blocked — no leak.
    assert.equal(t.isAllowed("u", 2000), false, "boundary requests still active");

    // One millisecond later they fall outside the window and expire, freeing slots.
    assert.equal(t.isAllowed("u", 2001), true,  "first after window rolls over");
    assert.equal(t.isAllowed("u", 2001), true,  "second after window rolls over");
    assert.equal(t.isAllowed("u", 2001), false, "third after rollover must be blocked");
  });

  it("handles burst at window boundary with correct inclusive filter", () => {
    const t = new SlidingWindowThrottle(3, 500);
    // Fill at t=500
    t.isAllowed("u", 500);
    t.isAllowed("u", 500);
    // t=1000: windowStart=500. Requests at 500 should still count.
    assert.equal(t.isAllowed("u", 1000), true,  "3rd slot (2 from 500 active)");
    assert.equal(t.isAllowed("u", 1000), false, "4th should be blocked");
  });

  it("window boundary is inclusive — requests at windowStart remain active", () => {
    const t = new SlidingWindowThrottle(1, 100);
    t.isAllowed("u", 100);
    // t=200: windowStart=100. Request at 100 is exactly at boundary — must still count.
    assert.equal(t.isAllowed("u", 200), false, "request at boundary still active, must block");
  });

  it("window boundary correctly expires after windowMs + 1ms", () => {
    const t = new SlidingWindowThrottle(1, 100);
    t.isAllowed("u", 100);
    // t=201: windowStart=101. Request at 100 < 101 — now expired.
    assert.equal(t.isAllowed("u", 201), true, "request past boundary by 1ms, should be allowed");
  });
});

describe("SlidingWindowThrottle — state consistency", () => {
  it("activeCount matches isAllowed decisions", () => {
    const t = new SlidingWindowThrottle(5, 1000);
    t.isAllowed("u", 0);
    t.isAllowed("u", 100);
    t.isAllowed("u", 900);
    assert.equal(t.activeCount("u", 1000), 3);
    // At 1001, request at 0 is expired (1001-1000=1, 0 < 1)
    assert.equal(t.activeCount("u", 1001), 2);
  });

  it("reset clears all state for a user", () => {
    const t = new SlidingWindowThrottle(1, 10000);
    t.isAllowed("u", 100);
    t.reset("u");
    assert.equal(t.isAllowed("u", 200), true);
    assert.equal(t.activeCount("u", 300), 1);
  });

  it("large number of users tracked independently", () => {
    const t = new SlidingWindowThrottle(2, 10000);
    for (let i = 0; i < 50; i++) {
      assert.equal(t.isAllowed(`u${i}`, 100), true);
      assert.equal(t.isAllowed(`u${i}`, 200), true);
      assert.equal(t.isAllowed(`u${i}`, 300), false);
    }
  });

  it("rapid back-to-back calls dont corrupt state", () => {
    const t = new SlidingWindowThrottle(3, 5000);
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(t.isAllowed("u", 1000 + i));
    }
    // First 3 allowed, rest blocked
    assert.deepEqual(results, [true, true, true, false, false, false, false, false, false, false]);
  });

  it("expired timestamps are properly cleaned from internal storage", () => {
    const t = new SlidingWindowThrottle(2, 100);
    t.isAllowed("u", 0);
    t.isAllowed("u", 50);
    // Advance well past window
    assert.equal(t.isAllowed("u", 500), true);
    // Internal state should no longer hold the old timestamps
    assert.equal(t.activeCount("u", 500), 1);
  });
});
