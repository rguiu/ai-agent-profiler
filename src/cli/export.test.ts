import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../store/index.js";
import { recommend } from "../recommend/index.js";
import { renderMarkdown } from "./export.js";

function makeDetail(): SessionDetail {
  return {
    session: {
      id: "sess-1",
      client: "opencode",
      cwd: "/repo",
      repo: "git@example:repo",
      started_at: "2026-01-01T00:00:00Z",
      first_seen_at: null,
      last_seen_at: null,
      meta: null,
      title: null,
      summary: null,
    },
    requests: [
      {
        id: "r1",
        provider: "deepseek",
        method: "POST",
        path: "/v1/chat/completions",
        status: 200,
        latency_ms: 120,
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T00:00:01Z",
        request_bytes: 100,
        response_bytes: 400,
        error: null,
        format: "anthropic",
        model: "deepseek-chat",
        input_tokens: 100,
        cached_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens: 50,
        stop_reason: "tool_use",
        cost: 0.001,
        tool_call_count: 1,
        kind: "main",
      },
    ],
    analysis: {
      toolUsage: [{ name: "read", count: 5, result_tokens: 4000 }],
      repeated: [
        { name: "read", arguments: '{"file_path":"/a.ts"}', count: 5 },
      ],
      growth: [],
      context: {
        requests: 1,
        system_tokens_total: 30,
        tools_tokens_total: 200,
        input_tokens_total: 0,
        cached_input_tokens_total: 0,
      },
      commands: [],
    },
  };
}

describe("renderMarkdown", () => {
  it("renders a readable session report with recommendations", () => {
    const detail = makeDetail();
    const md = renderMarkdown(detail, recommend(detail));

    expect(md).toContain("# Session sess-1");
    expect(md).toContain("**Client:** opencode");
    expect(md).toContain("## Summary");
    expect(md).toContain("Requests: 1");
    expect(md).toContain("## Recommendations");
    expect(md).toContain("/a.ts"); // from the repeated-read recommendation
    expect(md).toContain("## Tool usage");
    expect(md).toContain("| read | 5 | ~4,000 |");
    expect(md).toContain("## Requests");
    expect(md).toContain("deepseek-chat");
  });

  it("notes when there are no recommendations", () => {
    const detail = makeDetail();
    detail.analysis.repeated = [];
    detail.analysis.toolUsage = [];
    const md = renderMarkdown(detail, recommend(detail));
    expect(md).toContain("_No issues detected._");
  });
});
