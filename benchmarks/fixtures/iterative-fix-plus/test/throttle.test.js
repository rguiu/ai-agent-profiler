import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowThrottle } from "../src/throttle.js";

describe("SlidingWindowThrottle", () => {
  it("allows requests up to maxRequests within the window", () => {
    const t = new SlidingWindowThrottle(3, 1000);
    assert.equal(t.isAllowed("u1", 0), true);
    assert.equal(t.isAllowed("u1", 100), true);
    assert.equal(t.isAllowed("u1", 200), true);
  });

  it("blocks requests exceeding maxRequests", () => {
    const t = new SlidingWindowThrottle(2, 5000);
    assert.equal(t.isAllowed("u1", 100), true);
    assert.equal(t.isAllowed("u1", 200), true);
    assert.equal(t.isAllowed("u1", 300), false);
  });

  it("resets per-user state with reset()", () => {
    const t = new SlidingWindowThrottle(1, 10000);
    assert.equal(t.isAllowed("u1", 100), true);
    assert.equal(t.isAllowed("u1", 200), false);
    t.reset("u1");
    assert.equal(t.isAllowed("u1", 300), true);
  });

  it("activeCount returns correct non-expired count", () => {
    const t = new SlidingWindowThrottle(5, 1000);
    t.isAllowed("u1", 0);
    t.isAllowed("u1", 500);
    t.isAllowed("u1", 999);
    assert.equal(t.activeCount("u1", 1000), 3);
    // At time 1500, request at 0 is expired (1500-1000=500)
    assert.equal(t.activeCount("u1", 1500), 2);
  });

  it("tracks different users independently", () => {
    const t = new SlidingWindowThrottle(2, 10000);
    assert.equal(t.isAllowed("u1", 100), true);
    assert.equal(t.isAllowed("u2", 200), true);
    assert.equal(t.isAllowed("u1", 300), true);
    assert.equal(t.isAllowed("u1", 400), false); // u1 at limit
    assert.equal(t.isAllowed("u2", 500), true);  // u2 still has capacity
  });

  it("exposes maxRequests and windowMs", () => {
    const t = new SlidingWindowThrottle(5, 3000);
    assert.equal(t.maxRequests, 5);
    assert.equal(t.windowMs, 3000);
  });
});
