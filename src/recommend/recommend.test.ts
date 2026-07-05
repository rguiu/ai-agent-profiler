import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../store/index.js";
import { recommend } from "./recommend.js";

function detail(overrides: Partial<SessionDetail["analysis"]>): SessionDetail {
  return {
    session: {
      id: "s1",
      client: null,
      cwd: null,
      repo: null,
      started_at: null,
      first_seen_at: null,
      last_seen_at: null,
      meta: null,
    },
    requests: [],
    analysis: {
      toolUsage: [],
      repeated: [],
      growth: [],
      context: { requests: 0, system_tokens_total: 0, tools_tokens_total: 0 },
      ...overrides,
    },
  };
}

describe("recommend", () => {
  it("flags a repeated file read", () => {
    const recs = recommend(
      detail({
        repeated: [
          { name: "read", arguments: '{"file_path":"/a.ts"}', count: 5 },
        ],
      }),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]?.kind).toBe("repeated_file_read");
    expect(recs[0]?.severity).toBe("high");
    expect(recs[0]?.title).toContain("/a.ts");
  });

  it("flags a repeated non-read tool call generically", () => {
    const recs = recommend(
      detail({
        repeated: [{ name: "grep", arguments: '{"q":"foo"}', count: 3 }],
      }),
    );
    expect(recs[0]?.kind).toBe("repeated_tool_call");
    expect(recs[0]?.severity).toBe("warn");
  });

  it("ignores tool calls repeated fewer than the threshold", () => {
    const recs = recommend(
      detail({ repeated: [{ name: "read", arguments: null, count: 2 }] }),
    );
    expect(recs).toHaveLength(0);
  });

  it("flags high tool-result amplification", () => {
    const recs = recommend(
      detail({
        toolUsage: [{ name: "bash", count: 2, result_tokens: 12000 }],
      }),
    );
    expect(recs[0]?.kind).toBe("high_amplification");
    expect(recs[0]?.severity).toBe("high");
  });

  it("flags static context duplication", () => {
    const recs = recommend(
      detail({
        context: {
          requests: 10,
          system_tokens_total: 500,
          tools_tokens_total: 8000,
        },
      }),
    );
    expect(recs[0]?.kind).toBe("context_duplication");
    expect(recs[0]?.title).toContain("re-sent");
  });

  it("flags large context growth", () => {
    const recs = recommend(
      detail({
        growth: [
          { id: "r1", started_at: null, input_tokens: 2000, output_tokens: 1 },
          { id: "r2", started_at: null, input_tokens: 30000, output_tokens: 1 },
        ],
      }),
    );
    expect(recs[0]?.kind).toBe("context_growth");
  });

  it("returns nothing for a clean session", () => {
    expect(recommend(detail({}))).toEqual([]);
  });
});
