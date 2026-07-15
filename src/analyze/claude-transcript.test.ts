import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeStats,
  locateTranscript,
  parseTranscript,
  projectSavings,
  projectSlug,
  toolResults,
  toolUseNames,
} from "./claude-transcript.js";

// Build a JSONL fixture file from event objects.
function fixture(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-transcript-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

const userMsg = (uuid: string, parent: string | null, text: string) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  message: { role: "user", content: text },
});

const assistantMsg = (
  uuid: string,
  parent: string | null,
  content: unknown,
  usage?: Record<string, number>,
) => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  message: { role: "assistant", content, usage },
});

const toolResultMsg = (
  uuid: string,
  parent: string | null,
  toolUseId: string,
  content: string,
) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  },
});

describe("projectSlug", () => {
  it("replaces slashes and dots with dashes", () => {
    expect(projectSlug("/Users/x/code/a.b")).toBe("-Users-x-code-a-b");
  });
});

describe("parseTranscript — tree walk", () => {
  it("reconstructs only the active leaf→root path, dropping abandoned branches", () => {
    // root(u1) → u2 → u3 (active leaf). u2 also has an abandoned child b1.
    const path = fixture([
      { type: "mode", mode: "default", sessionId: "s" }, // metadata, no uuid
      userMsg("u1", null, "hello"),
      assistantMsg("u2", "u1", "hi there"),
      userMsg("b1", "u2", "abandoned branch (rewound)"),
      userMsg("u3", "u2", "second question"),
    ]);
    const t = parseTranscript(path);
    // u1, u2, u3 on active path; b1 abandoned
    expect(t.messages.map((m) => m.uuid)).toEqual(["u1", "u2", "u3"]);
    expect(t.abandonedEvents).toBe(1);
    expect(t.branchPoints).toBe(1); // u2 has two children
    expect(t.eventTypeCounts.mode).toBe(1);
  });

  it("ignores metadata-only events when building the message array", () => {
    const path = fixture([
      { type: "file-history-snapshot", snapshot: {}, messageId: "x" },
      userMsg("u1", null, "hi"),
      { type: "attachment", uuid: "a1", parentUuid: "u1", attachment: {} },
      assistantMsg("u2", "a1", "yo"),
    ]);
    const t = parseTranscript(path);
    expect(t.messages).toHaveLength(2);
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // attachment a1 is on the path but carries no message
    expect(t.activePathEvents).toBe(3); // u1, a1, u2
  });

  it("skips malformed lines without aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "aap-transcript-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      JSON.stringify(userMsg("u1", null, "ok")) +
        "\n{ this is not json\n" +
        JSON.stringify(assistantMsg("u2", "u1", "fine")) +
        "\n",
    );
    const t = parseTranscript(path);
    expect(t.messages).toHaveLength(2);
  });
});

describe("toolResults / toolUseNames", () => {
  it("extracts tool_result blocks and attributes them to tool names via tool_use ids", () => {
    const path = fixture([
      userMsg("u1", null, "run ls"),
      assistantMsg("u2", "u1", [
        { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } },
      ]),
      toolResultMsg("u3", "u2", "tu1", "file1\nfile2\n"),
    ]);
    const t = parseTranscript(path);
    const names = toolUseNames(t.messages);
    expect(names.get("tu1")).toBe("Bash");
    const results = toolResults(t.messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.toolUseId).toBe("tu1");
    expect(results[0]!.bytes).toBeGreaterThan(0);
  });
});

describe("computeStats", () => {
  it("sums cache usage from assistant events and tool-result tokens by tool", () => {
    const path = fixture([
      userMsg("u1", null, "hi"),
      assistantMsg(
        "u2",
        "u1",
        [{ type: "tool_use", id: "tu1", name: "Read" }],
        {
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
      ),
      toolResultMsg("u3", "u2", "tu1", "x".repeat(4000)),
    ]);
    const t = parseTranscript(path);
    const stats = computeStats(t);
    expect(stats.reportedCacheReadTokens).toBe(1000);
    expect(stats.reportedCacheCreationTokens).toBe(200);
    expect(stats.toolResultCount).toBe(1);
    expect(stats.tokensByTool.Read).toBeGreaterThan(0);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.userMessages).toBe(2); // the prompt + the tool_result carrier
  });
});

describe("projectSavings", () => {
  it("projects stableTruncate on oversized results", () => {
    const path = fixture([
      userMsg("u1", null, "go"),
      assistantMsg("u2", "u1", [{ type: "tool_use", id: "tu1", name: "Bash" }]),
      // ~8000 tokens (32000 chars), threshold default 4096 bytes → 1024 tokens
      toolResultMsg("u3", "u2", "tu1", "y".repeat(32000)),
    ]);
    const t = parseTranscript(path);
    const [trunc] = projectSavings(t);
    expect(trunc!.strategy).toBe("stableTruncate");
    expect(trunc!.tokensSaved).toBeGreaterThan(0);
  });

  it("projects dedup on identical repeated tool results", () => {
    const big = "z".repeat(1000);
    const path = fixture([
      userMsg("u1", null, "go"),
      assistantMsg("u2", "u1", [{ type: "tool_use", id: "tu1", name: "Read" }]),
      toolResultMsg("u3", "u2", "tu1", big),
      assistantMsg("u4", "u3", [{ type: "tool_use", id: "tu2", name: "Read" }]),
      toolResultMsg("u5", "u4", "tu2", big), // duplicate content
    ]);
    const t = parseTranscript(path);
    const dedup = projectSavings(t).find((s) => s.strategy === "dedup");
    expect(dedup!.tokensSaved).toBeGreaterThan(0);
  });

  it("projects stripTools savings for named tools", () => {
    const path = fixture([
      userMsg("u1", null, "go"),
      assistantMsg("u2", "u1", [
        { type: "tool_use", id: "tu1", name: "Workflow" },
      ]),
      toolResultMsg("u3", "u2", "tu1", "w".repeat(2000)),
    ]);
    const t = parseTranscript(path);
    const strip = projectSavings(t, { stripTools: ["Workflow"] }).find(
      (s) => s.strategy === "stripTools",
    );
    expect(strip!.tokensSaved).toBeGreaterThan(0);
    expect(strip!.detail).toContain("1 results");
  });
});

describe("locateTranscript", () => {
  it("returns a direct .jsonl path when it exists", () => {
    const path = fixture([userMsg("u1", null, "hi")]);
    expect(locateTranscript(path)).toBe(path);
  });

  it("returns null for a missing path", () => {
    expect(locateTranscript("/nonexistent/x.jsonl")).toBeNull();
  });
});
