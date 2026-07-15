import { describe, expect, it } from "vitest";
import { REGISTRY, type Registry } from "./filter-runner.js";

function applyFilter(
  registry: Registry,
  command: string,
  subcommand: string,
  input: string,
  args: string[] = [],
): string {
  const cmdEntry = registry[command];
  if (!cmdEntry) return input;
  const entry = cmdEntry[subcommand] ?? cmdEntry[""];
  if (!entry?.filter) return input;
  return entry.filter(input, args);
}

describe("git filters", () => {
  it("status: keeps branch and modified files", () => {
    const input = "## main...origin/main\n M src/foo.ts\n?? new.txt\n";
    const out = applyFilter(REGISTRY, "git", "status", input);
    expect(out).toContain("## main...origin/main");
    expect(out).toContain(" M src/foo.ts");
    expect(out).toContain("?? new.txt");
  });

  it("status: preserves output when no branch line", () => {
    const input = " M file.txt\n";
    const out = applyFilter(REGISTRY, "git", "status", input);
    expect(out).toContain(" M file.txt");
  });

  it("diff: truncates at max lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`+line ${i}`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "git", "diff", input);
    expect(out).toContain("... (truncated)");
    expect(out.split("\n").length).toBeLessThanOrEqual(102);
  });

  it("log: pass through (no filter)", () => {
    const input = "abc123 init\n";
    const out = applyFilter(REGISTRY, "git", "log", input);
    expect(out).toBe(input);
  });

  it("show: limits diff hunks per file", () => {
    const lines: string[] = [
      "commit abc1234",
      "Author: test",
      "",
      "    message",
      "",
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
    ];
    for (let i = 0; i < 100; i++) lines.push(`+line ${i}`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "git", "show", input);
    const outLines = out.split("\n");
    // Should have commit info + truncated diff
    expect(out).toContain("commit abc1234");
    expect(out).toContain("diff --git");
    expect(outLines.length).toBeLessThan(lines.length);
  });
});

describe("grep filter", () => {
  it("deduplicates by file: max 5 matches per file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`src/foo.ts:${i}: match ${i}`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "grep", "", input);
    const outLines = out.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(5);
  });

  it("passes through when under max lines", () => {
    const input = "src/foo.ts:1: match\nsrc/bar.ts:2: other\n";
    const out = applyFilter(REGISTRY, "grep", "", input);
    expect(out).toBe("src/foo.ts:1: match\nsrc/bar.ts:2: other");
  });
});

describe("ls filter", () => {
  it("limits to 40 entries", () => {
    const lines: string[] = ["/some/dir:"];
    for (let i = 0; i < 100; i++) lines.push(`file${i}.txt`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "ls", "", input);
    expect(out.split("\n").length).toBeLessThanOrEqual(41);
    expect(out).toContain("/some/dir:");
  });

  it("passes through when small", () => {
    const input = "/some/dir:\nfile1.txt\nfile2.txt\n";
    const out = applyFilter(REGISTRY, "ls", "", input);
    expect(out).toBe("/some/dir:\nfile1.txt\nfile2.txt");
  });
});

describe("find filter", () => {
  it("strips permission denied errors", () => {
    const input = "file.txt\nfind: foo: Permission denied\nbar.txt\n";
    const out = applyFilter(REGISTRY, "find", "", input);
    expect(out).not.toContain("Permission denied");
    expect(out).toContain("file.txt");
    expect(out).toContain("bar.txt");
  });

  it("limits to 60 results", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`file${i}.txt`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "find", "", input);
    expect(out.split("\n").length).toBeLessThanOrEqual(60);
  });
});

describe("cat filter", () => {
  it("limits to 60 lines and appends truncation marker", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`line ${i}`);
    const input = lines.join("\n");
    const out = applyFilter(REGISTRY, "cat", "", input);
    expect(out).toContain("... (truncated)");
    expect(out.split("\n").length).toBeLessThanOrEqual(61);
  });

  it("passes through when small", () => {
    const input = "hello\nworld\n";
    const out = applyFilter(REGISTRY, "cat", "", input);
    expect(out).toBe("hello\nworld");
  });
});

describe("node --test filter", () => {
  it("strips passing tests and keeps failures", () => {
    const input = [
      "TAP version 13",
      "1..3",
      "ok 1 - passes",
      "not ok 2 - fails",
      "  ---",
      "  message: expected true got false",
      "  ...",
      "ok 3 - also passes",
      "# pass 2",
      "# fail 1",
      "# tests 3",
    ].join("\n");
    const out = applyFilter(REGISTRY, "node", "test", input);
    expect(out).not.toContain("ok 1 - passes");
    expect(out).not.toContain("ok 3 - also passes");
    expect(out).toContain("not ok 2 - fails");
    expect(out).toContain("message: expected true got false");
    expect(out).toContain("2/3 passed, 1 failed");
  });

  it("shows all passed when no failures", () => {
    const input = [
      "TAP version 13",
      "1..2",
      "ok 1 - test a",
      "ok 2 - test b",
      "# pass 2",
      "# tests 2",
    ].join("\n");
    const out = applyFilter(REGISTRY, "node", "test", input);
    expect(out).toContain("2/2 passed");
    expect(out).not.toContain("ok 1");
  });
});

describe("npm filter", () => {
  it("shows ok on success", () => {
    const input = "PASS all tests\nTests: 5 passed\n";
    const out = applyFilter(REGISTRY, "npm", "test", input, ["test"]);
    expect(out).toBe("ok npm test");
  });

  it("shows errors on failure", () => {
    const input =
      "FAIL src/test.ts\n  Error: something broke\nTests: 4 passed, 1 failed";
    const out = applyFilter(REGISTRY, "npm", "test", input, ["test"]);
    expect(out).toContain("FAIL src/test.ts");
    expect(out).toContain("---");
  });
});

describe("cargo filters", () => {
  it("test: keeps test results, drops compilation noise", () => {
    const input = [
      "   Compiling foo v0.1.0",
      "   Compiling bar v0.2.0",
      "    Finished test",
      "running 5 tests",
      "test test_a ... ok",
      "test test_b ... FAILED",
      "failures:",
      "    test_b",
    ].join("\n");
    const out = applyFilter(REGISTRY, "cargo", "test", input);
    expect(out).toContain("running 5 tests");
    expect(out).toContain("test test_a ... ok");
    expect(out).toContain("test test_b ... FAILED");
    expect(out).not.toContain("Compiling");
  });

  it("build: keeps error/warning lines", () => {
    const input = [
      "   Compiling foo",
      "error[E0308]: mismatched types",
      "   --> src/main.rs:10:5",
      "warning: unused variable",
    ].join("\n");
    const out = applyFilter(REGISTRY, "cargo", "build", input);
    expect(out).toContain("error[E0308]");
    expect(out).toContain("warning: unused variable");
    expect(out).not.toContain("Compiling");
  });

  it("build: shows ok on success", () => {
    const input = "   Compiling foo\n    Finished dev";
    const out = applyFilter(REGISTRY, "cargo", "build", input);
    expect(out).toBe("ok cargo build");
  });
});

describe("passthrough for unknown commands", () => {
  it("no filter for unknown command", () => {
    const input = "output\n";
    const out = applyFilter(REGISTRY, "unknown_cmd", "", input);
    expect(out).toBe(input);
  });

  it("no filter for unknown subcommand", () => {
    const input = "some git output\n";
    const out = applyFilter(REGISTRY, "git", "unknown_sub", input);
    expect(out).toBe(input);
  });
});
