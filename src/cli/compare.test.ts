import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../store/index.js";
import { renderComparison, summarize } from "./compare.js";

function makeDetail(id: string, requests: number): SessionDetail {
  return {
    session: {
      id,
      client: "opencode",
      cwd: null,
      repo: null,
      started_at: null,
      first_seen_at: null,
      last_seen_at: null,
      meta: null,
    },
    requests: Array.from({ length: requests }, (_, i) => ({
      id: `${id}-r${i}`,
      provider: "deepseek",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      latency_ms: 100,
      started_at: `2026-01-01T00:00:0${i}Z`,
      ended_at: `2026-01-01T00:00:0${i + 1}Z`,
      request_bytes: 10,
      response_bytes: 20,
      error: null,
      format: "anthropic",
      model: "deepseek-chat",
      input_tokens: 100,
      cached_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: 50,
      stop_reason: "end_turn",
      cost: 0.001,
      tool_call_count: 1,
    })),
    analysis: {
      toolUsage: [{ name: "read", count: requests, result_tokens: 500 }],
      repeated: [],
      growth: [],
      context: {
        requests,
        system_tokens_total: 0,
        tools_tokens_total: 0,
        input_tokens_total: 0,
        cached_input_tokens_total: 0,
      },
      commands: [],
    },
    optimize: [],
  };
}

describe("summarize", () => {
  it("aggregates per-session metrics", () => {
    const s = summarize(makeDetail("sess-a", 3));
    expect(s.requests).toBe(3);
    expect(s.inputTokens).toBe(300);
    expect(s.outputTokens).toBe(150);
    expect(s.toolCalls).toBe(3);
    expect(s.distinctTools).toBe(1);
    expect(s.resultTokens).toBe(500);
    expect(s.wallMs).toBeGreaterThan(0);
  });

  it("carries session meta and tool-def tokens for baseline collection", () => {
    const detail = makeDetail("sess-m", 2);
    detail.session.meta = {
      task: "fix-bug",
      agent: "opencode",
      verify: "pass",
    };
    detail.analysis.context.tools_tokens_total = 4321;
    const s = summarize(detail);
    expect(s.meta).toEqual({
      task: "fix-bug",
      agent: "opencode",
      verify: "pass",
    });
    expect(s.toolsTokens).toBe(4321);
  });

  it("treats cached tokens as included in input for openai/deepseek", () => {
    const detail = makeDetail("sess-oa", 2);
    for (const r of detail.requests) {
      r.format = "openai";
      r.input_tokens = 100;
      r.cached_input_tokens = 30;
    }
    const s = summarize(detail);
    expect(s.cachedInputTokens).toBe(60);
    expect(s.inputTokens).toBe(140);
    expect(s.totalInputTokens).toBe(200);
  });

  it("treats cached tokens as separate from input for anthropic", () => {
    const detail = makeDetail("sess-an", 2);
    for (const r of detail.requests) {
      r.format = "anthropic";
      r.input_tokens = 100;
      r.cached_input_tokens = 30;
    }
    const s = summarize(detail);
    expect(s.cachedInputTokens).toBe(60);
    expect(s.inputTokens).toBe(200);
    expect(s.totalInputTokens).toBe(260);
  });
});

describe("renderComparison", () => {
  it("renders sessions as side-by-side columns", () => {
    const output = renderComparison([
      summarize(makeDetail("sess-aaaa", 3)),
      summarize(makeDetail("sess-bbbb", 8)),
    ]);
    expect(output).toContain("Session comparison");
    expect(output).toContain("sess-aaaa");
    expect(output).toContain("sess-bbbb");
    expect(output).toContain("Requests");
    expect(output).toContain("300");
    expect(output).toContain("800");
  });
});
