import { describe, expect, it } from "vitest";
import { extractWorkingDirectory } from "./env-block.js";

describe("extractWorkingDirectory", () => {
  it("reads a Claude Code env block", () => {
    const system = [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "",
      "Here is useful information about the environment you are running in:",
      "<env>",
      "Working directory: /Users/me/code/ai-agent-profiler",
      "Is directory a git repo: Yes",
      "Platform: darwin",
      "</env>",
    ].join("\n");
    expect(extractWorkingDirectory(system)).toBe(
      "/Users/me/code/ai-agent-profiler",
    );
  });

  it("tolerates the indented opencode variant", () => {
    const system = [
      "Here is some useful information about the environment you are running in:",
      "<env>",
      "  Working directory: /home/me/src/thing",
      "  Is directory a git repo: no",
      "</env>",
    ].join("\n");
    expect(extractWorkingDirectory(system)).toBe("/home/me/src/thing");
  });

  it("accepts 'Primary working directory'", () => {
    expect(
      extractWorkingDirectory("Primary working directory: /srv/app\n"),
    ).toBe("/srv/app");
  });

  it("strips one layer of quotes", () => {
    expect(extractWorkingDirectory('Working directory: "/srv/my app"\n')).toBe(
      "/srv/my app",
    );
  });

  it("ignores relative paths and unrelated prompts", () => {
    expect(extractWorkingDirectory("Working directory: src/app\n")).toBeNull();
    expect(extractWorkingDirectory("Summarize this conversation.")).toBeNull();
    expect(extractWorkingDirectory("")).toBeNull();
    expect(extractWorkingDirectory("Working directory: \n")).toBeNull();
  });
});
