import { describe, expect, it } from "vitest";
import {
  analyzePrefixStability,
  classifyPrefixTransition,
  summarizePrefixStability,
  type PrefixInput,
} from "./prefix-stability.js";

function fp(
  overrides: Partial<PrefixInput> & { requestId: string },
): PrefixInput {
  return {
    systemHash: "sys",
    toolsHash: "tools",
    messageHashes: [],
    messageCount: 0,
    ...overrides,
  };
}

describe("classifyPrefixTransition", () => {
  it("marks the first request as 'first'", () => {
    const cur = fp({ requestId: "r1", messageHashes: ["m1"], messageCount: 1 });
    expect(classifyPrefixTransition(null, cur)).toEqual({ kind: "first" });
  });

  it("classifies a pure append as append-only", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: ["m1", "m2"],
      messageCount: 2,
    });
    const cur = fp({
      requestId: "r2",
      messageHashes: ["m1", "m2", "m3"],
      messageCount: 3,
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "append-only",
    });
  });

  it("reports a tools break when the tool defs hash changes", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: ["m1"],
      messageCount: 1,
      toolsHash: "tools-v1",
    });
    const cur = fp({
      requestId: "r2",
      messageHashes: ["m1", "m2"],
      messageCount: 2,
      toolsHash: "tools-v2",
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "rewrite",
      brokenSegment: "tools",
    });
  });

  it("reports a system break when the system hash changes (even if tools also changed)", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: ["m1"],
      messageCount: 1,
      systemHash: "sys-v1",
      toolsHash: "tools-v1",
    });
    const cur = fp({
      requestId: "r2",
      messageHashes: ["m1"],
      messageCount: 1,
      systemHash: "sys-v2",
      toolsHash: "tools-v2",
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "rewrite",
      brokenSegment: "system",
    });
  });

  it("reports the lowest diverging message index on a mid-message rewrite (recap)", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: ["m1", "m2", "m3"],
      messageCount: 3,
    });
    // A recap rewrites message[1] onward, even though a new message is appended.
    const cur = fp({
      requestId: "r2",
      messageHashes: ["m1", "m2-rewritten", "m4"],
      messageCount: 3,
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "rewrite",
      brokenSegment: "message[1]",
    });
  });

  it("treats divergence before prev.message_count as a rewrite even if hashes match up to a shorter common length", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: ["m1", "m2"],
      messageCount: 2,
    });
    const cur = fp({
      requestId: "r2",
      messageHashes: ["m1"],
      messageCount: 1,
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "rewrite",
      brokenSegment: "message[1]",
    });
  });

  it("handles empty/missing hashes without throwing", () => {
    const prev = fp({
      requestId: "r1",
      messageHashes: [],
      messageCount: 0,
      systemHash: null,
      toolsHash: null,
    });
    const cur = fp({
      requestId: "r2",
      messageHashes: [],
      messageCount: 0,
      systemHash: null,
      toolsHash: null,
    });
    expect(classifyPrefixTransition(prev, cur)).toEqual({
      kind: "append-only",
    });
  });
});

describe("analyzePrefixStability / summarizePrefixStability", () => {
  it("summarizes a stable session with no breaks", () => {
    const inputs: PrefixInput[] = [
      fp({ requestId: "r1", messageHashes: ["m1"], messageCount: 1 }),
      fp({
        requestId: "r2",
        messageHashes: ["m1", "m2"],
        messageCount: 2,
      }),
      fp({
        requestId: "r3",
        messageHashes: ["m1", "m2", "m3"],
        messageCount: 3,
      }),
    ];
    const results = analyzePrefixStability(inputs);
    expect(results.map((r) => r.transition.kind)).toEqual([
      "first",
      "append-only",
      "append-only",
    ]);
    const summary = summarizePrefixStability(results);
    expect(summary.requests).toBe(3);
    expect(summary.longestStableRun).toBe(2);
    expect(summary.breakPoints).toEqual([]);
    expect(summary.dominantBreakSegment).toBeNull();
  });

  it("reports break points and the dominant break segment across a session", () => {
    const inputs: PrefixInput[] = [
      fp({
        requestId: "r1",
        messageHashes: ["m1"],
        messageCount: 1,
        toolsHash: "t1",
      }),
      fp({
        requestId: "r2",
        messageHashes: ["m1", "m2"],
        messageCount: 2,
        toolsHash: "t1",
      }),
      // tools reorder breaks the run
      fp({
        requestId: "r3",
        messageHashes: ["m1", "m2", "m3"],
        messageCount: 3,
        toolsHash: "t2",
      }),
      fp({
        requestId: "r4",
        messageHashes: ["m1", "m2", "m3", "m4"],
        messageCount: 4,
        toolsHash: "t2",
      }),
      // another tools break
      fp({
        requestId: "r5",
        messageHashes: ["m1", "m2", "m3", "m4", "m5"],
        messageCount: 5,
        toolsHash: "t3",
      }),
    ];
    const results = analyzePrefixStability(inputs);
    const summary = summarizePrefixStability(results);
    expect(summary.breakPoints).toEqual(["r3", "r5"]);
    expect(summary.dominantBreakSegment).toBe("tools");
    expect(summary.longestStableRun).toBe(1);
  });
});
