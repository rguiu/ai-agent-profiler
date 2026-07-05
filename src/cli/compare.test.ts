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
      output_tokens: 50,
      stop_reason: "end_turn",
      cost: 0.001,
      tool_call_count: 1,
    })),
    analysis: {
      toolUsage: [{ name: "read", count: requests, result_tokens: 500 }],
      repeated: [],
      growth: [],
      context: { requests, system_tokens_total: 0, tools_tokens_total: 0 },
    },
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
});

describe("renderComparison", () => {
  it("renders sessions as side-by-side columns", () => {
    const md = renderComparison([
      summarize(makeDetail("sess-aaaa", 3)),
      summarize(makeDetail("sess-bbbb", 8)),
    ]);
    expect(md).toContain("# Session comparison");
    expect(md).toContain("| Metric | sess-aaa | sess-bbb |");
    expect(md).toContain("| Requests | 3 | 8 |");
    expect(md).toContain("| Input tokens | 300 | 800 |");
  });
});
