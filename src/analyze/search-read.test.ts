import { describe, expect, it } from "vitest";
import { detectSearchReadChains } from "./search-read.js";

function tc(
  requestId: string,
  startedAt: string,
  name: string,
  args: string | null,
  ordinal = 0,
): NonNullable<Parameters<typeof detectSearchReadChains>[0]>[number] {
  return {
    request_id: requestId,
    started_at: startedAt,
    ordinal,
    name,
    arguments: args,
    result_tokens: null,
  };
}

describe("detectSearchReadChains", () => {
  it("detects a grep → read chain in the same directory", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"rg pattern src/"}'),
      tc("r2", "2024-01-01T00:01:00Z", "Read", '{"file_path":"src/foo.ts"}'),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.searchCommand).toBe("rg pattern src/");
    expect(chains[0]!.readFile).toBe("src/foo.ts");
    expect(chains[0]!.stepsBetween).toBe(1);
  });

  it("detects find → read chain with absolute paths", () => {
    const toolCalls = [
      tc(
        "r1",
        "2024-01-01T00:00:00Z",
        "bash",
        '{"command":"find /home/user/proj -name \\"*.ts\\""}',
      ),
      tc(
        "r2",
        "2024-01-01T00:01:00Z",
        "Read",
        '{"file_path":"/home/user/proj/src/main.ts"}',
      ),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.readFile).toBe("/home/user/proj/src/main.ts");
  });

  it("detects ls → cat chain", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"ls /tmp/data/"}'),
      tc(
        "r2",
        "2024-01-01T00:01:00Z",
        "Read",
        '{"file_path":"/tmp/data/log.txt"}',
      ),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.searchCategory).toBe("search");
  });

  it("does not match reads before the search", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "Read", '{"file_path":"src/foo.ts"}'),
      tc("r2", "2024-01-01T00:01:00Z", "bash", '{"command":"rg pattern src/"}'),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(0);
  });

  it("does not match reads outside the search directory", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"rg pattern src/"}'),
      tc("r2", "2024-01-01T00:01:00Z", "Read", '{"file_path":"tests/bar.ts"}'),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(0);
  });

  it("ignores non-search bash commands", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"npm test"}'),
      tc("r2", "2024-01-01T00:01:00Z", "Read", '{"file_path":"src/foo.ts"}'),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(0);
  });

  it("matches read within search dir using same request", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"rg pattern src/"}'),
      tc("r1", "2024-01-01T00:00:00Z", "Read", '{"file_path":"src/foo.ts"}', 1),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.stepsBetween).toBe(0);
  });

  it("returns multiple chains for multiple matches", () => {
    const toolCalls = [
      tc("r1", "2024-01-01T00:00:00Z", "bash", '{"command":"rg pattern src/"}'),
      tc("r2", "2024-01-01T00:01:00Z", "Read", '{"file_path":"src/foo.ts"}'),
      tc("r3", "2024-01-01T00:02:00Z", "Read", '{"file_path":"src/bar.ts"}'),
    ];
    const chains = detectSearchReadChains(toolCalls);
    expect(chains).toHaveLength(2);
  });

  it("returns empty for no tool calls", () => {
    expect(detectSearchReadChains([])).toEqual([]);
  });
});
