import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/event-bus.js";

describe("EventBus", () => {
  it("emits events to subscribers", () => {
    const bus = new EventBus();
    const received = [];
    bus.on("test", (d) => received.push(d));
    bus.emit("test", { value: 1 });
    bus.emit("test", { value: 2 });
    assert.deepEqual(received, [{ value: 1 }, { value: 2 }]);
  });

  it("once fires exactly once", () => {
    const bus = new EventBus();
    let count = 0;
    bus.once("ping", () => count++);
    bus.emit("ping", {});
    bus.emit("ping", {});
    assert.equal(count, 1);
  });

  it("off removes listener", () => {
    const bus = new EventBus();
    let count = 0;
    const fn = () => count++;
    bus.on("x", fn);
    bus.emit("x", {});
    bus.off("x", fn);
    bus.emit("x", {});
    assert.equal(count, 1);
  });

  it("history returns recent events in reverse order", () => {
    const bus = new EventBus();
    bus.emit("a", 1);
    bus.emit("b", 2);
    bus.emit("c", 3);
    const h = bus.history(3);
    assert.equal(h.length, 3);
    assert.equal(h[0].event, "c");
    assert.equal(h[1].event, "b");
    assert.equal(h[2].event, "a");
  });

  it("history respects maxHistory limit", () => {
    const bus = new EventBus({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      bus.emit("tick", i);
    }
    const h = bus.history(10);
    assert.equal(h.length, 5);
    // Should keep the 5 most recent (5,6,7,8,9)
    assert.equal(h[0].data, 9);
    assert.equal(h[4].data, 5);
  });

  it("waitFor resolves on next emit", async () => {
    const bus = new EventBus();
    const promise = bus.waitFor("done", 1000);
    bus.emit("done", { result: 42 });
    const data = await promise;
    assert.equal(data.result, 42);
  });

  it("waitFor rejects on timeout", async () => {
    const bus = new EventBus();
    await assert.rejects(
      () => bus.waitFor("never", 50),
      /Timed out/,
    );
  });

  it("clear removes all listeners and history", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("x", () => count++);
    bus.emit("x", {});
    assert.equal(bus.history().length, 1);
    bus.clear();
    assert.equal(bus.history().length, 0); // history cleared
    bus.emit("x", {}); // no listener fires
    assert.equal(count, 1);
    assert.equal(bus.listenerCount("x"), 0);
  });

  it("listener errors do not crash emitter", () => {
    const bus = new EventBus();
    let ok = false;
    bus.on("x", () => { throw new Error("boom"); });
    bus.on("x", () => { ok = true; });
    bus.emit("x", {});
    assert.ok(ok);
  });
});
