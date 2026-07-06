import { describe, expect, it } from "vitest";
import { OptimizeLayer } from "./layer.js";

describe("OptimizeLayer", () => {
  describe("dedup", () => {
    it("returns stub on second identical tool call", () => {
      const layer = new OptimizeLayer({ dedup: true, truncate: false });
      const content = "line1\nline2\nline3\nline4\nline5\n".repeat(20);
      const r1 = layer.rewriteToolResult("Read", "/src/foo.ts", content);
      expect(r1).toBe(content); // first call passes through

      const r2 = layer.rewriteToolResult("Read", "/src/foo.ts", content);
      expect(r2).toContain("unchanged since turn");
      expect(r2).toContain("tokens omitted");
    });

    it("does not dedup when content changes", () => {
      const layer = new OptimizeLayer({ dedup: true, truncate: false });
      const v1 = "const x = 1;\n".repeat(50);
      const v2 = "const x = 2;\n".repeat(50);

      layer.rewriteToolResult("Read", "/src/foo.ts", v1);
      const r2 = layer.rewriteToolResult("Read", "/src/foo.ts", v2);
      expect(r2).toBe(v2); // different content, no dedup
    });

    it("tracks actions with tokensSaved", () => {
      const layer = new OptimizeLayer({ dedup: true, truncate: false });
      const content = "x".repeat(4000); // ~1000 tokens
      layer.rewriteToolResult("Read", "/f.ts", content);
      layer.rewriteToolResult("Read", "/f.ts", content);

      const actions = layer.getActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]!.type).toBe("dedup");
      expect(actions[0]!.tokensSaved).toBeGreaterThan(900);
    });

    it("deduplicates across different tools with same key", () => {
      const layer = new OptimizeLayer({ dedup: true, truncate: false });
      const content = "hello world\n".repeat(100);
      layer.rewriteToolResult("cat", "file.txt", content);
      // Same tool+args → dedup
      const r = layer.rewriteToolResult("cat", "file.txt", content);
      expect(r).toContain("unchanged");
    });
  });

  describe("truncate", () => {
    it("truncates results exceeding threshold", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 500,
      });
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: some code here`);
      const content = lines.join("\n");

      const result = layer.rewriteToolResult("Bash", "cat big.ts", content);
      expect(result).toContain("lines omitted");
      expect(result.split("\n").length).toBeLessThan(content.split("\n").length);
    });

    it("does not truncate small results", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 8192,
      });
      const content = "short result";
      expect(layer.rewriteToolResult("Bash", "ls", content)).toBe(content);
    });

    it("preserves head and tail", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 100,
      });
      const lines = Array.from({ length: 200 }, (_, i) => `LINE_${i}`);
      const content = lines.join("\n");

      const result = layer.rewriteToolResult("Bash", "cmd", content);
      expect(result).toContain("LINE_0");
      expect(result).toContain("LINE_49"); // last of head (50 lines)
      expect(result).toContain("LINE_199"); // tail
      expect(result).not.toContain("LINE_100"); // omitted middle
    });

    it("records tokensSaved in actions", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 100,
      });
      const lines = Array.from({ length: 300 }, (_, i) => `line ${i}: ${"x".repeat(40)}`);
      layer.rewriteToolResult("Bash", "cat big", lines.join("\n"));

      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
      expect(layer.getActions()[0]!.type).toBe("truncate");
    });
  });

  describe("stablePrefix", () => {
    it("canonicalises tool definitions", () => {
      const layer = new OptimizeLayer({ dedup: false, truncate: false, stablePrefix: true });
      const body1 = JSON.stringify({
        model: "claude",
        tools: [
          { name: "Read", description: "read files", input_schema: {} },
          { name: "Bash", description: "run shell", input_schema: {} },
        ],
        messages: [{ role: "user", content: "hi" }],
      });
      // Same tools, different key order
      const body2 = JSON.stringify({
        model: "claude",
        tools: [
          { description: "read files", name: "Read", input_schema: {} },
          { input_schema: {}, name: "Bash", description: "run shell" },
        ],
        messages: [{ role: "user", content: "hello" }],
      });

      const r1 = layer.rewriteRequestBody(Buffer.from(body1));
      const r2 = layer.rewriteRequestBody(Buffer.from(body2));

      // Both should produce the same tool JSON ordering
      const p1 = JSON.parse(r1.toString()) as { tools: unknown[] };
      const p2 = JSON.parse(r2.toString()) as { tools: unknown[] };
      expect(JSON.stringify(p1.tools)).toBe(JSON.stringify(p2.tools));
    });
  });

  describe("pruneStale", () => {
    it("prunes old tool results beyond the turn threshold", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: true,
        pruneAfterTurns: 3,
      });

      // Simulate 5 turns of requests to advance the turn counter
      for (let i = 0; i < 5; i++) {
        layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      }

      // Now on turn 6, messages from turn 1-2 should be prunable
      const body = JSON.stringify({
        messages: [
          { role: "assistant", content: "I'll read that" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "x".repeat(2000), // ~500 tokens, old
              },
            ],
          },
          { role: "assistant", content: "Now doing something else" },
          { role: "assistant", content: "More turns" },
          { role: "assistant", content: "Recent turn" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t2",
                content: "recent result", // small + recent, should not be pruned
              },
            ],
          },
        ],
      });

      const result = layer.rewriteRequestBody(Buffer.from(body));
      const parsed = JSON.parse(result.toString()) as {
        messages: Array<{ content: unknown }>;
      };
      const firstToolResult = (parsed.messages[1]!.content as Array<{ content: string }>)[0]!;
      expect(firstToolResult.content).toContain("pruned");

      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
    });
  });

  describe("combined", () => {
    it("applies multiple optimizations and reports total savings", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: true,
        truncateThreshold: 200,
      });

      const bigContent = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
      layer.rewriteToolResult("Read", "/big.ts", bigContent); // truncated
      layer.rewriteToolResult("Read", "/big.ts", bigContent); // deduped (uses truncated hash)

      expect(layer.getActions().length).toBeGreaterThanOrEqual(1);
      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
    });
  });
});
