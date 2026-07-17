import { describe, expect, it } from "vitest";
import { SessionRegistry } from "./registry.js";

const info = (id: string) => ({ id, startedAt: "2026-01-01T00:00:00.000Z" });

describe("SessionRegistry idle eviction", () => {
  it("prunes sessions idle longer than the window", () => {
    const idleMs = 2 * 60 * 60 * 1000; // 2h
    const reg = new SessionRegistry(idleMs);
    const t0 = 1_000_000;
    reg.register(info("old"), t0);
    reg.register(info("fresh"), t0);

    // 'fresh' is touched just before the sweep; 'old' is not.
    const sweepAt = t0 + idleMs + 1;
    reg.get("fresh", sweepAt);

    expect(reg.prune(sweepAt)).toBe(1);
    expect(reg.get("old", sweepAt)).toBeUndefined();
    expect(reg.get("fresh", sweepAt)).toBeDefined();
    expect(reg.size).toBe(1);
  });

  it("recovers a pruned session when re-registered", () => {
    const reg = new SessionRegistry(1000);
    const t0 = 1_000_000;
    reg.register(info("s"), t0);
    expect(reg.prune(t0 + 2000)).toBe(1);
    expect(reg.get("s")).toBeUndefined();

    reg.register(info("s"), t0 + 3000);
    expect(reg.get("s", t0 + 3000)).toBeDefined();
  });

  it("get refreshes activity, keeping a session alive across sweeps", () => {
    const idleMs = 1000;
    const reg = new SessionRegistry(idleMs);
    const t0 = 1_000_000;
    reg.register(info("s"), t0);

    reg.get("s", t0 + 900); // touch before it would expire
    expect(reg.prune(t0 + 1200)).toBe(0);
    expect(reg.get("s", t0 + 1200)).toBeDefined();
  });

  it("does not evict sessions when hydrated recently", () => {
    const reg = new SessionRegistry(1000);
    const t0 = 1_000_000;
    reg.hydrate([info("a"), info("b")], t0);
    expect(reg.prune(t0 + 500)).toBe(0);
    expect(reg.size).toBe(2);
  });

  it("recovers a missing session from the loader and repopulates memory", () => {
    const persisted = { ...info("s"), meta: { armada_node: "n1" } };
    let calls = 0;
    const reg = new SessionRegistry(1000, (id) => {
      calls++;
      return id === "s" ? persisted : undefined;
    });

    // Not in memory yet: pulled from the loader.
    expect(reg.get("s", 1000)?.meta?.armada_node).toBe("n1");
    expect(reg.size).toBe(1);
    // Now cached: loader isn't consulted again.
    expect(reg.get("s", 1100)?.meta?.armada_node).toBe("n1");
    expect(calls).toBe(1);
  });

  it("returns undefined when neither memory nor loader has the session", () => {
    const reg = new SessionRegistry(1000, () => undefined);
    expect(reg.get("nope")).toBeUndefined();
  });

  it("re-loads via the loader after a prune", () => {
    const t0 = 1_000_000;
    const reg = new SessionRegistry(1000, (id) =>
      id === "s" ? info("s") : undefined,
    );
    reg.register(info("s"), t0);
    expect(reg.prune(t0 + 2000)).toBe(1);
    // Gone from memory, but the loader brings it back.
    expect(reg.get("s", t0 + 3000)).toBeDefined();
    expect(reg.size).toBe(1);
  });
});
