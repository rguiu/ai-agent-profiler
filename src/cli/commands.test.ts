import { describe, expect, it } from "vitest";
import { classifyCommand, commandBreakdown } from "./commands.js";

describe("classifyCommand", () => {
  it("reduces a command to its program name", () => {
    expect(classifyCommand("grep -rn foo src")).toBe("grep");
    expect(classifyCommand("/usr/bin/rg pattern .")).toBe("rg");
  });

  it("keeps the subcommand for multiplexers", () => {
    expect(classifyCommand("npm test")).toBe("npm test");
    expect(classifyCommand("git status --short")).toBe("git status");
  });

  it("takes the first command in a pipe or chain", () => {
    expect(classifyCommand("cat a.txt | grep b")).toBe("cat");
    expect(classifyCommand("cd src && ls -la")).toBe("cd");
  });

  it("strips leading env assignments", () => {
    expect(classifyCommand("FOO=1 BAR=2 node script.js")).toBe(
      "node script.js",
    );
  });
});

describe("commandBreakdown", () => {
  it("aggregates by command, sorted by result tokens", () => {
    const rows = commandBreakdown([
      { arguments: '{"command":"grep -r x ."}', result_tokens: 100 },
      { arguments: '{"command":"grep y ."}', result_tokens: 50 },
      { arguments: '{"command":"cat big.txt"}', result_tokens: 5000 },
      { arguments: '{"description":"no command here"}', result_tokens: 10 },
      { arguments: null, result_tokens: 10 },
    ]);
    expect(rows).toEqual([
      { command: "cat", count: 1, resultTokens: 5000 },
      { command: "grep", count: 2, resultTokens: 150 },
    ]);
  });
});
