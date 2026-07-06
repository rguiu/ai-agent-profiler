import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pipeline } from "../src/pipeline.js";
import { RateLimiter } from "../src/rate-limiter.js";

describe("Pipeline", () => {
  it("runs stages sequentially", async () => {
    const order = [];
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("first", [
      { id: "a", fn: async () => { order.push("first:a"); return "A"; } },
    ]);
    p.addStage("second", [
      { id: "b", fn: async (ctx) => { order.push("second:b"); return ctx; } },
    ]);
    await p.run({ initial: true });
    assert.deepEqual(order, ["first:a", "second:b"]);
  });

  it("passes context between stages", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("compute", [
      { id: "sum", fn: async (ctx) => ctx.x + ctx.y },
    ]);
    p.addStage("format", [
      { id: "str", fn: async (ctx) => `result=${ctx.sum}` },
    ]);
    const result = await p.run({ x: 3, y: 4 });
    assert.equal(result.str, "result=7");
  });

  it("preserves earlier stage results in context", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("stage1", [
      { id: "a", fn: async () => "from-stage1" },
    ]);
    p.addStage("stage2", [
      { id: "b", fn: async (ctx) => `got:${ctx.a}` },
    ]);
    p.addStage("stage3", [
      { id: "c", fn: async (ctx) => ({ a: ctx.a, b: ctx.b }) },
    ]);
    const result = await p.run();
    // stage3 should see both stage1 and stage2 results
    assert.equal(result.c.a, "from-stage1");
    assert.equal(result.c.b, "got:from-stage1");
  });

  it("runs tasks within a stage concurrently", async () => {
    let peak = 0;
    let current = 0;
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      fn: async () => {
        current++;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 30));
        current--;
        return i;
      },
    }));
    p.addStage("parallel", tasks);
    await p.run();
    assert.ok(peak >= 2, `Expected concurrency, got peak ${peak}`);
  });

  it("abort stops further stages", async () => {
    const ran = [];
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("s1", [
      { id: "x", fn: async () => { ran.push("s1"); p.abort(); return 1; } },
    ]);
    p.addStage("s2", [
      { id: "y", fn: async () => { ran.push("s2"); return 2; } },
    ]);
    await p.run();
    assert.deepEqual(ran, ["s1"]);
  });

  it("initial context is available in first stage", async () => {
    const p = new Pipeline({ limiter: new RateLimiter(1000) });
    p.addStage("read", [
      { id: "val", fn: async (ctx) => ctx.input * 2 },
    ]);
    const result = await p.run({ input: 21 });
    assert.equal(result.val, 42);
  });

  it("throws on empty stage", () => {
    const p = new Pipeline();
    assert.throws(
      () => p.addStage("empty", []),
      /at least one task/,
    );
  });
});
