import { describe, expect, it } from "vitest";
import { OptimizeLayer } from "./layer.js";

function makeRequest(messages: unknown[], tools?: unknown[]) {
  return Buffer.from(JSON.stringify({ messages, tools: tools ?? [] }));
}

describe("cache-aware pruning (Idea B)", () => {
  it("prunes messages at breakpoint but tags cacheRate=true for observability", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      insertBreakpoints: true,
      pruneAfterTurns: 1,
      reorderVolatile: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: bigResult,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: bigResult },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok3" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));

    // Message at index 0 has cache_control — pruning now proceeds but
    // the action is tagged cacheRate=true (was inside cached prefix)
    const pruneActions = layer
      .getActions()
      .filter((a) => a.type === "prune_stale");
    expect(pruneActions.length).toBeGreaterThan(0);
    const inCache = pruneActions.filter((a) => a.cacheRate === true);
    expect(inCache.length).toBeGreaterThan(0);
  });

  it("prunes messages after the last breakpoint normally", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      insertBreakpoints: true,
      pruneAfterTurns: 1,
      reorderVolatile: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "short",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", content: bigResult },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "assistant", content: [{ type: "text", text: "ok3" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    // Advance turns enough
    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());

    // Message at index 2 is after the breakpoint (index 0), should be pruned
    const msg2 = parsed.messages[2];
    const block = msg2.content[0];
    expect(block.content).not.toBe(bigResult);
    expect(block.content).toContain("[");
  });

  it("does not restrict pruning when insertBreakpoints is false", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      insertBreakpoints: false,
      pruneAfterTurns: 1,
      reorderVolatile: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: bigResult,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());

    // Without insertBreakpoints, pruning is NOT restricted by cache markers
    const block = parsed.messages[0].content[0];
    expect(block.content).not.toBe(bigResult);
    expect(block.content).toContain("[");
  });

  it("sets cacheRate on prune_stale actions", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      insertBreakpoints: true,
      pruneAfterTurns: 1,
      reorderVolatile: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: bigResult },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "assistant", content: [{ type: "text", text: "ok3" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));

    const pruneActions = layer
      .getActions()
      .filter((a) => a.type === "prune_stale");
    expect(pruneActions.length).toBeGreaterThan(0);
    // No breakpoint marker in messages, so cacheRate should be false
    for (const a of pruneActions) {
      expect(a.cacheRate).toBe(false);
    }
  });
});

describe("pruneStabilityWindow", () => {
  it("suppresses prune_stale for N turns after a prune event", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      pruneAfterTurns: 1,
      pruneStabilityWindow: 3,
      insertBreakpoints: false,
      reorderVolatile: false,
      collapseSystem: false,
      pruneUnusedTools: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: bigResult },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    // Turn 1: no prune (threshold not met)
    layer.rewriteRequestBody(makeRequest(messages));
    // Turn 2: prune fires (turn - pruneAfterTurns = 1 > 0)
    layer.rewriteRequestBody(makeRequest(messages));
    const prunesAfter2 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;
    expect(prunesAfter2).toBeGreaterThan(0);

    // Turns 3, 4: within stability window (lastPrune=2, window=3), suppressed
    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    const prunesAfter4 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;
    expect(prunesAfter4).toBe(prunesAfter2);

    // Turn 5: window expired (5 - 2 = 3 >= 3), prune fires again
    layer.rewriteRequestBody(makeRequest(messages));
    const prunesAfter5 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;
    expect(prunesAfter5).toBeGreaterThan(prunesAfter2);
  });

  it("prunes every turn when window is 0 (legacy behaviour)", () => {
    const layer = new OptimizeLayer({
      pruneStale: true,
      pruneAfterTurns: 1,
      pruneStabilityWindow: 0,
      insertBreakpoints: false,
      reorderVolatile: false,
      collapseSystem: false,
      pruneUnusedTools: false,
    });

    const bigResult = "x".repeat(400);
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: bigResult },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    layer.rewriteRequestBody(makeRequest(messages));
    layer.rewriteRequestBody(makeRequest(messages));
    const after2 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;

    layer.rewriteRequestBody(makeRequest(messages));
    const after3 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;
    expect(after3).toBeGreaterThan(after2);

    layer.rewriteRequestBody(makeRequest(messages));
    const after4 = layer
      .getActions()
      .filter((a) => a.type === "prune_stale").length;
    expect(after4).toBeGreaterThan(after3);
  });
});

describe("volatile content reordering (Idea D)", () => {
  it("moves system-reminder blocks from earlier user messages to last user message", () => {
    const layer = new OptimizeLayer({
      reorderVolatile: true,
      pruneStale: false,
      insertBreakpoints: false,
    });

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nAvailable skills: foo\n</system-reminder>",
          },
          { type: "text", text: "Hello Claude" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Do something" }],
      },
    ];

    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());

    // First user message should no longer have the system-reminder
    const firstUser = parsed.messages[0];
    expect(firstUser.content).toHaveLength(1);
    expect(firstUser.content[0].text).toBe("Hello Claude");

    // Last user message should have the reminder prepended
    const lastUser = parsed.messages[2];
    expect(lastUser.content).toHaveLength(2);
    expect(lastUser.content[0].text).toContain("<system-reminder>");
    expect(lastUser.content[1].text).toBe("Do something");
  });

  it("does not move blocks from the last user message", () => {
    const layer = new OptimizeLayer({
      reorderVolatile: true,
      pruneStale: false,
      insertBreakpoints: false,
    });

    const messages = [
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nfoo\n</system-reminder>" },
          { type: "text", text: "query" },
        ],
      },
    ];

    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());

    // Only one user message (the last), nothing should move
    const userMsg = parsed.messages[1];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].text).toContain("<system-reminder>");
  });

  it("does nothing when no system-reminder blocks exist", () => {
    const layer = new OptimizeLayer({
      reorderVolatile: true,
      pruneStale: false,
      insertBreakpoints: false,
    });

    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: [{ type: "text", text: "Bye" }] },
    ];

    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());
    expect(parsed.messages[0].content[0].text).toBe("Hello");
    expect(parsed.messages[2].content[0].text).toBe("Bye");
  });

  it("records a reorder_volatile action with token count", () => {
    const layer = new OptimizeLayer({
      reorderVolatile: true,
      pruneStale: false,
      insertBreakpoints: false,
    });

    const reminder =
      "<system-reminder>\n" + "x".repeat(200) + "\n</system-reminder>";
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: reminder },
          { type: "text", text: "hello" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "world" }] },
    ];

    layer.rewriteRequestBody(makeRequest(messages));
    const actions = layer
      .getActions()
      .filter((a) => a.type === "reorder_volatile");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.detail).toContain("1 <system-reminder> block(s)");
    expect(actions[0]!.tokensSaved).toBe(0);
  });

  it("handles multiple reminders from multiple user messages", () => {
    const layer = new OptimizeLayer({
      reorderVolatile: true,
      pruneStale: false,
      insertBreakpoints: false,
    });

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>A</system-reminder>" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>B</system-reminder>" },
          { type: "text", text: "query1" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      {
        role: "user",
        content: [{ type: "text", text: "final question" }],
      },
    ];

    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());

    // Last user message (index 4) should have both reminders prepended
    const lastUser = parsed.messages[4];
    expect(lastUser.content).toHaveLength(3);
    expect(lastUser.content[0].text).toContain("A");
    expect(lastUser.content[1].text).toContain("B");
    expect(lastUser.content[2].text).toBe("final question");
  });

  it("is disabled by default", () => {
    const layer = new OptimizeLayer({ pruneStale: false });

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>A</system-reminder>" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    const out = layer.rewriteRequestBody(makeRequest(messages));
    const parsed = JSON.parse(out.toString());
    // Should NOT move because reorderVolatile defaults to false
    expect(parsed.messages[0].content[0].text).toContain("<system-reminder>");
  });
});

describe("tool-def token tracking (Idea C)", () => {
  it("accumulates tool-def tokens across turns", () => {
    const layer = new OptimizeLayer({
      pruneStale: false,
      reorderVolatile: false,
    });
    const tools = [
      {
        name: "Read",
        description: "Reads a file",
        input_schema: { type: "object" },
      },
      {
        name: "Write",
        description: "Writes a file",
        input_schema: { type: "object" },
      },
    ];

    layer.rewriteRequestBody(makeRequest([], tools));
    const after1 = layer.getToolDefTokens();
    expect(after1).toBeGreaterThan(0);

    layer.rewriteRequestBody(makeRequest([], tools));
    expect(layer.getToolDefTokens()).toBe(after1 * 2);
  });
});
