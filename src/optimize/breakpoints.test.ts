import { describe, expect, it } from "vitest";
import { OptimizeLayer } from "./layer.js";

function makeAnthropicBody(opts: {
  system?: unknown;
  tools?: unknown[];
  messages?: unknown[];
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      system: opts.system ?? [{ type: "text", text: "You are a helpful assistant." }],
      tools: opts.tools ?? [
        { name: "Read", description: "Read a file", input_schema: {} },
        { name: "Write", description: "Write a file", input_schema: {} },
      ],
      messages: opts.messages ?? [
        {
          role: "user",
          content: [{ type: "text", text: "first question" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second question" }],
        },
      ],
    }),
  );
}

describe("insertCacheBreakpoints", () => {
  it("places cache_control on system, last tool, and context boundary", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    const out = layer.rewriteRequestBody(makeAnthropicBody({}));
    const parsed = JSON.parse(out.toString());

    // System: last block gets cache_control
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });

    // Tools: last tool def gets cache_control
    expect(parsed.tools[1].cache_control).toEqual({ type: "ephemeral" });

    // Context boundary: the first user message (second-to-last user msg)
    const firstUserMsg = parsed.messages[0];
    const lastBlock = firstUserMsg.content[firstUserMsg.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts string system to array form with cache_control", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    const body = makeAnthropicBody({ system: "You are a coding assistant." });
    const out = layer.rewriteRequestBody(body);
    const parsed = JSON.parse(out.toString());

    expect(Array.isArray(parsed.system)).toBe(true);
    expect(parsed.system[0]).toEqual({
      type: "text",
      text: "You are a coding assistant.",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not duplicate breakpoints on consecutive turns", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    // First turn
    const out1 = layer.rewriteRequestBody(makeAnthropicBody({}));
    const parsed1 = JSON.parse(out1.toString());

    // Feed back the same parsed body (simulating the proxy re-sending it)
    const out2 = layer.rewriteRequestBody(Buffer.from(JSON.stringify(parsed1)));
    const parsed2 = JSON.parse(out2.toString());

    // Should still be exactly one cache_control per breakpoint, not nested
    expect(parsed2.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed2.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips breakpoints when there are too few messages for context boundary", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    const body = makeAnthropicBody({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });

    const out = layer.rewriteRequestBody(body);
    const parsed = JSON.parse(out.toString());

    // System and tools still get breakpoints
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.tools[1].cache_control).toEqual({ type: "ephemeral" });

    // But no context boundary (only 1 user message)
    const msg = parsed.messages[0];
    expect(msg.content[0].cache_control).toBeUndefined();
  });

  it("does not insert breakpoints when disabled", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: false,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    const body = makeAnthropicBody({});
    const out = layer.rewriteRequestBody(body);
    const parsed = JSON.parse(out.toString());

    expect(parsed.system[0].cache_control).toBeUndefined();
    expect(parsed.tools[1].cache_control).toBeUndefined();
  });

  it("records an insert_breakpoints action", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    layer.rewriteRequestBody(makeAnthropicBody({}));
    const actions = layer.getActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("insert_breakpoints");
    expect(actions[0]!.detail).toContain("3 cache_control breakpoint(s)");
  });

  it("handles multi-block system content", () => {
    const layer = new OptimizeLayer({
      insertBreakpoints: true,
      dedup: false,
      truncate: false,
      stablePrefix: false,
      pruneStale: false,
      collapseSystem: false,
      pruneUnusedTools: false,
      suppressReread: false,
    });

    const body = makeAnthropicBody({
      system: [
        { type: "text", text: "System preamble." },
        { type: "text", text: "Additional instructions." },
      ],
    });

    const out = layer.rewriteRequestBody(body);
    const parsed = JSON.parse(out.toString());

    // Only the last system block gets the marker
    expect(parsed.system[0].cache_control).toBeUndefined();
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
