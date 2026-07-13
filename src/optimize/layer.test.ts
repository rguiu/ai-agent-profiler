import { describe, expect, it } from "vitest";
import { OptimizeLayer } from "./layer.js";

describe("OptimizeLayer", () => {
  describe("dedup", () => {
    it("returns stub on second identical tool call", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: false,
        suppressReread: false,
      });
      const content = "line1\nline2\nline3\nline4\nline5\n".repeat(20);
      const r1 = layer.rewriteToolResult("Read", "/src/foo.ts", content);
      expect(r1).toBe(content);

      const r2 = layer.rewriteToolResult("Read", "/src/foo.ts", content);
      expect(r2).toContain("unchanged since turn");
    });

    it("does not dedup when content changes", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: false,
        suppressReread: false,
      });
      const v1 = "const x = 1;\n".repeat(50);
      const v2 = "const x = 2;\n".repeat(50);

      layer.rewriteToolResult("Read", "/src/foo.ts", v1);
      const r2 = layer.rewriteToolResult("Read", "/src/foo.ts", v2);
      expect(r2).toBe(v2);
    });

    it("tracks actions with tokensSaved", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: false,
        suppressReread: false,
      });
      const content = "x".repeat(4000); // ~1000 tokens
      layer.rewriteToolResult("Read", "/f.ts", content);
      layer.rewriteToolResult("Read", "/f.ts", content);

      const actions = layer.getActions();
      expect(actions).toHaveLength(1);
      expect(actions[0]!.type).toBe("dedup");
      expect(actions[0]!.tokensSaved).toBeGreaterThan(900);
    });

    it("deduplicates across different tools with same key", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: false,
        suppressReread: false,
      });
      const content = "hello world\n".repeat(100);
      layer.rewriteToolResult("cat", "file.txt", content);
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
        suppressReread: false,
      });
      const lines = Array.from(
        { length: 200 },
        (_, i) => `line ${i}: some code here`,
      );
      const content = lines.join("\n");

      const result = layer.rewriteToolResult("Bash", "cat big.ts", content);
      expect(result).toContain("lines omitted");
      expect(result.split("\n").length).toBeLessThan(
        content.split("\n").length,
      );
    });

    it("does not truncate small results", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 8192,
        suppressReread: false,
      });
      const content = "short result";
      expect(layer.rewriteToolResult("Bash", "ls", content)).toBe(content);
    });

    it("preserves head and tail", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 100,
        suppressReread: false,
      });
      const lines = Array.from({ length: 200 }, (_, i) => `LINE_${i}`);
      const content = lines.join("\n");

      const result = layer.rewriteToolResult("Bash", "cmd", content);
      expect(result).toContain("LINE_0");
      expect(result).toContain("LINE_39"); // last of head (40 lines)
      expect(result).toContain("LINE_199"); // tail
      expect(result).not.toContain("LINE_100"); // omitted middle
    });

    it("records tokensSaved in actions", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: true,
        truncateThreshold: 100,
        suppressReread: false,
      });
      const lines = Array.from(
        { length: 300 },
        (_, i) => `line ${i}: ${"x".repeat(40)}`,
      );
      layer.rewriteToolResult("Bash", "cat big", lines.join("\n"));

      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
      expect(layer.getActions()[0]!.type).toBe("truncate");
    });
  });

  describe("stablePrefix", () => {
    it("canonicalises tool definitions", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: true,
        suppressReread: false,
      });
      const body1 = JSON.stringify({
        model: "claude",
        tools: [
          { name: "Read", description: "read files", input_schema: {} },
          { name: "Bash", description: "run shell", input_schema: {} },
        ],
        messages: [{ role: "user", content: "hi" }],
      });
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
        suppressReread: false,
      });

      for (let i = 0; i < 5; i++) {
        layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      }

      const body = JSON.stringify({
        messages: [
          { role: "assistant", content: "I'll read that" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "x".repeat(2000),
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
                content: "recent result",
              },
            ],
          },
        ],
      });

      const result = layer.rewriteRequestBody(Buffer.from(body));
      const parsed = JSON.parse(result.toString()) as {
        messages: Array<{ content: unknown }>;
      };
      const firstToolResult = (
        parsed.messages[1]!.content as Array<{ content: string }>
      )[0]!;
      expect(firstToolResult.content).toContain("[tool:");

      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
    });

    it("does not prune results smaller than 50 tokens", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: true,
        pruneAfterTurns: 2,
        suppressReread: false,
      });

      for (let i = 0; i < 4; i++) {
        layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      }

      const body = JSON.stringify({
        messages: [
          { role: "assistant", content: "did something" },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: "short", // < 50 tokens, should not be pruned
              },
            ],
          },
        ],
      });

      const result = layer.rewriteRequestBody(Buffer.from(body));
      const parsed = JSON.parse(result.toString()) as {
        messages: Array<{ content: unknown }>;
      };
      const toolResult = (
        parsed.messages[1]!.content as Array<{ content: string }>
      )[0]!;
      expect(toolResult.content).toBe("short");
    });
  });

  describe("suppressReread", () => {
    it("suppresses read of a file just written", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: true,
        suppressWithinTurns: 2,
      });

      // Advance to turn 1
      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));

      // Write a file
      const writeArgs = JSON.stringify({ file_path: "/src/app.ts" });
      layer.rewriteToolResult("Write", writeArgs, "ok");

      // Read the same file back — should be suppressed
      const readArgs = JSON.stringify({ file_path: "/src/app.ts" });
      const bigContent = "const x = 1;\n".repeat(100);
      const result = layer.rewriteToolResult("Read", readArgs, bigContent);

      expect(result).toContain("file just written");
      expect(result).toContain("tokens suppressed");
      expect(layer.getActions()).toHaveLength(1);
      expect(layer.getActions()[0]!.type).toBe("suppress_reread");
    });

    it("does not suppress if write was too many turns ago", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: true,
        suppressWithinTurns: 2,
      });

      // Turn 1: write
      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      layer.rewriteToolResult(
        "Write",
        JSON.stringify({ file_path: "/src/app.ts" }),
        "ok",
      );

      // Advance 3 more turns (beyond suppressWithinTurns=2)
      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));
      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));

      // Read on turn 4 — should NOT be suppressed
      const bigContent = "const x = 1;\n".repeat(100);
      const result = layer.rewriteToolResult(
        "Read",
        JSON.stringify({ file_path: "/src/app.ts" }),
        bigContent,
      );
      expect(result).toBe(bigContent);
    });

    it("does not suppress reads of unwritten files", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: true,
        suppressWithinTurns: 2,
      });

      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));

      // Write one file
      layer.rewriteToolResult(
        "Write",
        JSON.stringify({ file_path: "/src/a.ts" }),
        "ok",
      );

      // Read a different file — should pass through
      const content = "something\n".repeat(100);
      const result = layer.rewriteToolResult(
        "Read",
        JSON.stringify({ file_path: "/src/b.ts" }),
        content,
      );
      expect(result).toBe(content);
    });

    it("recognises Edit as a write operation", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: true,
        suppressWithinTurns: 2,
      });

      layer.rewriteRequestBody(Buffer.from(JSON.stringify({ messages: [] })));

      layer.rewriteToolResult(
        "Edit",
        JSON.stringify({ file_path: "/src/foo.ts" }),
        "applied",
      );

      const bigContent = "line\n".repeat(200);
      const result = layer.rewriteToolResult(
        "Read",
        JSON.stringify({ file_path: "/src/foo.ts" }),
        bigContent,
      );
      expect(result).toContain("file just written");
    });
  });

  describe("collapseSystem", () => {
    it("collapses identical system prompt on second request", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: false,
        collapseSystem: true,
      });

      const system = "You are a helpful assistant.\n".repeat(50);
      const body = JSON.stringify({
        system,
        messages: [{ role: "user", content: "hi" }],
      });

      // First request — passes through
      const r1 = layer.rewriteRequestBody(Buffer.from(body));
      const p1 = JSON.parse(r1.toString()) as { system: string };
      expect(p1.system).toBe(system);

      // Second request — collapsed
      const r2 = layer.rewriteRequestBody(Buffer.from(body));
      const p2 = JSON.parse(r2.toString()) as { system: string };
      expect(p2.system).toContain("[system unchanged");
      expect(p2.system).toContain("hash:");
      expect(layer.getActions().some((a) => a.type === "collapse_system")).toBe(
        true,
      );
    });

    it("does not collapse when system prompt changes", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: false,
        collapseSystem: true,
      });

      const body1 = JSON.stringify({ system: "A ".repeat(200), messages: [] });
      const body2 = JSON.stringify({ system: "B ".repeat(200), messages: [] });

      layer.rewriteRequestBody(Buffer.from(body1));
      const r2 = layer.rewriteRequestBody(Buffer.from(body2));
      const p2 = JSON.parse(r2.toString()) as { system: string };
      expect(p2.system).toBe("B ".repeat(200));
    });
  });

  describe("pruneUnusedTools", () => {
    it("prunes tool definitions not seen in assistant messages after N turns", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: false,
        collapseSystem: false,
        pruneUnusedTools: true,
        pruneUnusedToolsAfter: 3,
      });

      const tools = [
        { name: "Read", description: "read files", input_schema: {} },
        { name: "Bash", description: "run shell", input_schema: {} },
        { name: "Write", description: "write files", input_schema: {} },
      ];

      const messagesWithToolUse = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
        { role: "user", content: "continue" },
      ];

      // Turns 1-3: within threshold, tools pass through
      for (let i = 0; i < 3; i++) {
        layer.rewriteRequestBody(
          Buffer.from(JSON.stringify({ tools, messages: messagesWithToolUse })),
        );
      }

      // Turn 4: beyond threshold, unused tools should be pruned
      const result = layer.rewriteRequestBody(
        Buffer.from(JSON.stringify({ tools, messages: messagesWithToolUse })),
      );
      const parsed = JSON.parse(result.toString()) as { tools: unknown[] };

      // Only "Read" was used — Bash and Write should be pruned
      expect(parsed.tools).toHaveLength(1);
      expect((parsed.tools[0] as { name: string }).name).toBe("Read");
      expect(
        layer.getActions().some((a) => a.type === "prune_unused_tools"),
      ).toBe(true);
    });

    it("does not prune when no tools have been observed yet", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: false,
        collapseSystem: false,
        pruneUnusedTools: true,
        pruneUnusedToolsAfter: 2,
      });

      const tools = [
        { name: "Read", description: "read files", input_schema: {} },
      ];

      // Advance past the threshold but with no tool_use in messages
      for (let i = 0; i < 4; i++) {
        layer.rewriteRequestBody(
          Buffer.from(
            JSON.stringify({
              tools,
              messages: [{ role: "user", content: "hi" }],
            }),
          ),
        );
      }

      // No tool_use blocks seen → toolsUsed is empty → no pruning
      expect(
        layer.getActions().some((a) => a.type === "prune_unused_tools"),
      ).toBe(false);
    });

    it("keeps tools without a name field", () => {
      const layer = new OptimizeLayer({
        dedup: false,
        truncate: false,
        stablePrefix: false,
        pruneStale: false,
        suppressReread: false,
        collapseSystem: false,
        pruneUnusedTools: true,
        pruneUnusedToolsAfter: 1,
      });

      const tools = [
        { name: "Read", description: "read files", input_schema: {} },
        { description: "nameless tool", input_schema: {} },
        { name: "Bash", description: "run shell", input_schema: {} },
      ];

      const messages = [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
        { role: "user", content: "ok" },
      ];

      // Turn 1: establishes usage
      layer.rewriteRequestBody(
        Buffer.from(JSON.stringify({ tools, messages })),
      );

      // Turn 2: prune kicks in
      const result = layer.rewriteRequestBody(
        Buffer.from(JSON.stringify({ tools, messages })),
      );
      const parsed = JSON.parse(result.toString()) as {
        tools: Array<{ name?: string }>;
      };

      // Read (used) + nameless (kept) = 2; Bash (unused) pruned
      expect(parsed.tools).toHaveLength(2);
      expect(parsed.tools.some((t) => t.name === "Read")).toBe(true);
      expect(parsed.tools.some((t) => !t.name)).toBe(true);
      expect(parsed.tools.some((t) => t.name === "Bash")).toBe(false);
    });
  });

  describe("combined", () => {
    it("applies multiple optimizations and reports total savings", () => {
      const layer = new OptimizeLayer({
        dedup: true,
        truncate: true,
        truncateThreshold: 200,
        suppressReread: false,
      });

      const bigContent = Array.from(
        { length: 150 },
        (_, i) => `line ${i}`,
      ).join("\n");
      layer.rewriteToolResult("Read", "/big.ts", bigContent); // truncated
      layer.rewriteToolResult("Read", "/big.ts", bigContent); // deduped

      expect(layer.getActions().length).toBeGreaterThanOrEqual(1);
      expect(layer.getTotalTokensSaved()).toBeGreaterThan(0);
    });
  });

  describe("stableTruncate (cache-safe)", () => {
    const bigResult = Array.from({ length: 150 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const bodyWith = (content: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              tool_calls: [
                { id: "c1", function: { name: "bash", arguments: "{}" } },
              ],
            },
            { role: "tool", tool_call_id: "c1", content },
          ],
        }),
      );

    it("truncates large OpenAI-format tool results in the messages array", () => {
      const layer = new OptimizeLayer({
        stableTruncate: true,
        truncate: false,
        truncateThreshold: 200,
      });
      const out = layer.rewriteRequestBody(bodyWith(bigResult));
      const parsed = JSON.parse(out.toString()) as {
        messages: Array<{ content: string }>;
      };
      expect(parsed.messages[1]!.content).toContain("lines omitted");
      expect(layer.getActions()[0]!.type).toBe("stable_truncate");
    });

    it("is byte-stable: the same result truncates identically every request", () => {
      const layer = new OptimizeLayer({
        stableTruncate: true,
        truncate: false,
        truncateThreshold: 200,
      });
      const first = layer.rewriteRequestBody(bodyWith(bigResult)).toString();
      // Later request replays the ALREADY truncated history (agent re-sends it).
      const replayed = JSON.parse(first) as {
        messages: Array<{ content: string }>;
      };
      const second = layer
        .rewriteRequestBody(bodyWith(replayed.messages[1]!.content))
        .toString();
      // The truncated content must be left untouched on replay.
      const p1 = JSON.parse(first) as { messages: Array<{ content: string }> };
      const p2 = JSON.parse(second) as { messages: Array<{ content: string }> };
      expect(p2.messages[1]!.content).toBe(p1.messages[1]!.content);
    });

    it("records each distinct result only once across requests", () => {
      const layer = new OptimizeLayer({
        stableTruncate: true,
        truncate: false,
        truncateThreshold: 200,
      });
      layer.rewriteRequestBody(bodyWith(bigResult));
      layer.rewriteRequestBody(bodyWith(bigResult));
      const truncations = layer
        .getActions()
        .filter((a) => a.type === "stable_truncate");
      expect(truncations).toHaveLength(1);
    });

    it("leaves small results untouched", () => {
      const layer = new OptimizeLayer({
        stableTruncate: true,
        truncate: false,
        truncateThreshold: 200,
      });
      const out = layer.rewriteRequestBody(bodyWith("short\noutput"));
      const parsed = JSON.parse(out.toString()) as {
        messages: Array<{ content: string }>;
      };
      expect(parsed.messages[1]!.content).toBe("short\noutput");
      expect(layer.getActions()).toHaveLength(0);
    });
  });

  describe("shapeTestOutput (cache-safe)", () => {
    const passLog = [
      "> node --test test/*.test.js",
      "",
      ...Array.from({ length: 40 }, (_, i) => `ok ${i + 1} - case ${i + 1}`),
      "# tests 40",
      "# pass 40",
      "# fail 0",
    ].join("\n");
    const bodyWith = (content: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              tool_calls: [
                { id: "c1", function: { name: "bash", arguments: "{}" } },
              ],
            },
            { role: "tool", tool_call_id: "c1", content },
          ],
        }),
      );

    it("drops passing-test spam but keeps summary lines", () => {
      const layer = new OptimizeLayer({
        shapeTestOutput: true,
        stableTruncate: false,
      });
      const out = layer.rewriteRequestBody(bodyWith(passLog));
      const c = (
        JSON.parse(out.toString()) as { messages: Array<{ content: string }> }
      ).messages[1]!.content;
      expect(c).not.toContain("ok 20 - case 20");
      expect(c).toContain("# fail 0");
      expect(c).toContain("test output shaped");
      expect(layer.getActions()[0]!.type).toBe("shape_test_output");
    });

    it("keeps failing lines", () => {
      const failLog = passLog.replace("ok 7 - case 7", "not ok 7 - case 7");
      const layer = new OptimizeLayer({
        shapeTestOutput: true,
        stableTruncate: false,
      });
      const out = layer.rewriteRequestBody(bodyWith(failLog));
      const c = (
        JSON.parse(out.toString()) as { messages: Array<{ content: string }> }
      ).messages[1]!.content;
      expect(c).toContain("not ok 7 - case 7");
    });

    it("is idempotent: shaped output is left untouched on replay", () => {
      const layer = new OptimizeLayer({
        shapeTestOutput: true,
        stableTruncate: false,
      });
      const first = (
        JSON.parse(layer.rewriteRequestBody(bodyWith(passLog)).toString()) as {
          messages: Array<{ content: string }>;
        }
      ).messages[1]!.content;
      const second = (
        JSON.parse(layer.rewriteRequestBody(bodyWith(first)).toString()) as {
          messages: Array<{ content: string }>;
        }
      ).messages[1]!.content;
      expect(second).toBe(first);
    });

    it("ignores non-test tool output", () => {
      const layer = new OptimizeLayer({
        shapeTestOutput: true,
        stableTruncate: false,
      });
      const prose = "Here is a summary of the file.\nIt has some content.\n";
      const out = layer.rewriteRequestBody(bodyWith(prose));
      const c = (
        JSON.parse(out.toString()) as { messages: Array<{ content: string }> }
      ).messages[1]!.content;
      expect(c).toBe(prose);
      expect(layer.getActions()).toHaveLength(0);
    });
  });

  describe("prefixProbe (diagnostic)", () => {
    const body = (msgs: unknown[], tools?: unknown[]): Buffer =>
      Buffer.from(
        JSON.stringify(tools ? { messages: msgs, tools } : { messages: msgs }),
      );
    const filler = (n: number): string =>
      Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

    it("stays quiet for append-only growth", () => {
      const layer = new OptimizeLayer({ prefixProbe: true });
      const msgs: unknown[] = [{ role: "user", content: filler(500) }];
      layer.rewriteRequestBody(body(msgs));
      msgs.push({ role: "assistant", content: filler(500) });
      layer.rewriteRequestBody(body(msgs));
      msgs.push({ role: "tool", content: filler(500) });
      layer.rewriteRequestBody(body(msgs));
      expect(
        layer.getActions().filter((a) => a.type === "prefix_break"),
      ).toHaveLength(0);
    });

    it("stays quiet when tool defs are unchanged but messages grow (opencode ordering)", () => {
      const layer = new OptimizeLayer({ prefixProbe: true });
      const tools = [{ function: { name: "bash", description: filler(200) } }];
      const msgs: unknown[] = [{ role: "system", content: filler(300) }];
      layer.rewriteRequestBody(body(msgs, tools));
      msgs.push({ role: "assistant", content: "step 1" });
      layer.rewriteRequestBody(body(msgs, tools));
      msgs.push({ role: "assistant", content: "step 2" });
      layer.rewriteRequestBody(body(msgs, tools));
      expect(
        layer.getActions().filter((a) => a.type === "prefix_break"),
      ).toHaveLength(0);
    });

    it("flags a break when the system prompt changes", () => {
      const layer = new OptimizeLayer({ prefixProbe: true });
      const tail: unknown[] = [
        { role: "assistant", content: filler(500) },
        { role: "user", content: filler(500) },
      ];
      layer.rewriteRequestBody(
        body([{ role: "system", content: "AAA" }, ...tail]),
      );
      layer.rewriteRequestBody(
        body([{ role: "system", content: "BBB" }, ...tail]),
      );
      const breaks = layer
        .getActions()
        .filter((a) => a.type === "prefix_break");
      expect(breaks).toHaveLength(1);
      expect(breaks[0]!.detail).toContain("prefix edited");
    });

    it("flags a break when a prior message is edited (not appended)", () => {
      const layer = new OptimizeLayer({ prefixProbe: true });
      const msgs: unknown[] = [
        { role: "user", content: "task" },
        { role: "tool", content: filler(400) },
      ];
      layer.rewriteRequestBody(body(msgs));
      // Edit the OLD tool result in place, then append a new turn.
      const edited: unknown[] = [
        { role: "user", content: "task" },
        { role: "tool", content: filler(50) },
        { role: "assistant", content: "next" },
      ];
      layer.rewriteRequestBody(body(edited));
      const breaks = layer
        .getActions()
        .filter((a) => a.type === "prefix_break");
      expect(breaks).toHaveLength(1);
    });
  });

  describe("frozenCompact (long-session compaction)", () => {
    // ~2000-token message so a handful blow past the threshold.
    const bigMsg = (role: string, tag: string): Record<string, unknown> => ({
      role,
      content: Array.from(
        { length: 120 },
        (_, i) => `${tag} line ${i} lorem ipsum dolor sit amet consectetur`,
      ).join("\n"),
    });
    const buildBody = (msgs: unknown[]): Buffer =>
      Buffer.from(JSON.stringify({ messages: msgs }));
    const cfg = {
      frozenCompact: true,
      stableTruncate: false,
      shapeTestOutput: false,
      prefixProbe: false,
      compactThreshold: 8000,
      compactKeepTail: 3,
    };

    // Simulate an agent that re-sends the full growing history each turn,
    // returning the messages actually emitted upstream.
    const runTurn = (layer: OptimizeLayer, history: unknown[]): unknown[] => {
      const out = layer.rewriteRequestBody(buildBody(history));
      return (JSON.parse(out.toString()) as { messages: unknown[] }).messages;
    };

    it("does not compact below the threshold", () => {
      const layer = new OptimizeLayer(cfg);
      const history: unknown[] = [bigMsg("system", "SYS"), bigMsg("user", "A")];
      runTurn(layer, history);
      expect(
        layer.getActions().filter((a) => a.type === "frozen_compact"),
      ).toHaveLength(0);
    });

    it("compacts once past the threshold and keeps the tail intact", () => {
      const layer = new OptimizeLayer(cfg);
      const history: unknown[] = [bigMsg("system", "SYS")];
      for (let i = 0; i < 12; i++) history.push(bigMsg("user", `M${i}`));
      const emitted = runTurn(layer, history) as Array<{
        role: string;
        content: string;
      }>;
      const compactions = layer
        .getActions()
        .filter((a) => a.type === "frozen_compact");
      expect(compactions).toHaveLength(1);
      // anchor + summary + kept tail (3)
      expect(emitted).toHaveLength(1 + 1 + 3);
      expect(emitted[1]!.content).toContain("compacted");
      // the last 3 originals survive untouched
      expect(emitted[emitted.length - 1]!.content).toContain("M11");
    });

    it("FREEZES the boundary: no new compaction on the next few turns", () => {
      const layer = new OptimizeLayer(cfg);
      const history: unknown[] = [bigMsg("system", "SYS")];
      for (let i = 0; i < 12; i++) history.push(bigMsg("user", `M${i}`));
      runTurn(layer, history); // triggers first compaction

      // Agent appends 2 more turns (each still small relative to threshold).
      history.push(bigMsg("assistant", "R12"));
      const e1 = runTurn(layer, history) as Array<{ content: string }>;
      history.push(bigMsg("user", "M13"));
      const e2 = runTurn(layer, history) as Array<{ content: string }>;

      // Still exactly ONE compaction action — the boundary held.
      expect(
        layer.getActions().filter((a) => a.type === "frozen_compact"),
      ).toHaveLength(1);
      // Summary text is byte-identical across turns (no reset).
      expect(e1[1]!.content).toBe(e2[1]!.content);
    });

    it("summary is deterministic for identical folded content", () => {
      const build = (): string => {
        const layer = new OptimizeLayer(cfg);
        const history: unknown[] = [bigMsg("system", "SYS")];
        for (let i = 0; i < 12; i++) history.push(bigMsg("user", `M${i}`));
        const e = runTurn(layer, history) as Array<{ content: string }>;
        return e[1]!.content;
      };
      expect(build()).toBe(build());
    });
  });

  describe("upgradeCacheTtl", () => {
    const bodyWithMarkers = (): Buffer =>
      Buffer.from(
        JSON.stringify({
          system: [
            { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
          ],
          tools: [{ name: "Read", cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "t1",
                  content: "x",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        }),
      );

    it("leaves markers untouched when off (default)", () => {
      const layer = new OptimizeLayer({ upgradeCacheTtl: "off" });
      const out = layer.rewriteRequestBody(bodyWithMarkers()).toString("utf8");
      expect(out).not.toContain('"ttl"');
    });

    it("rewrites every ephemeral marker to a 1h ttl", () => {
      const layer = new OptimizeLayer({ upgradeCacheTtl: "1h" });
      const out = JSON.parse(
        layer.rewriteRequestBody(bodyWithMarkers()).toString("utf8"),
      );
      expect(out.system[0].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
      expect(out.tools[0].cache_control.ttl).toBe("1h");
      expect(out.messages[0].content[0].cache_control.ttl).toBe("1h");
    });

    it("does not add markers where the client placed none", () => {
      const layer = new OptimizeLayer({ upgradeCacheTtl: "1h" });
      const body = Buffer.from(
        JSON.stringify({
          system: "plain",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      const out = layer.rewriteRequestBody(body).toString("utf8");
      expect(out).not.toContain('"ttl"');
      expect(out).not.toContain("cache_control");
    });
  });
});
