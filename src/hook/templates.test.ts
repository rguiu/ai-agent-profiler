import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function realBin(name: string): string {
  const known: Record<string, string> = {
    git: "/usr/bin/git",
    ls: "/bin/ls",
    grep: "/usr/bin/rg",
    node: process.execPath,
    find: "/usr/bin/find",
    cat: "/bin/cat",
    npm: "/usr/local/bin/npm",
    cargo: `${process.env.HOME ?? "/root"}/.cargo/bin/cargo`,
  };
  if (name in known) return known[name]!;
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    return `/usr/bin/${name}`;
  }
}

function renderWrapper(
  dir: string,
  command: string,
  realName: string,
  filterJs: string,
): string {
  const template = `#!/bin/bash
output=$("__REAL_BIN__" "$@" 2>&1)
rc=$?
echo "$output" | node "__FILTER_JS__" "__COMMAND__" "$@"
exit $rc`;

  const dest = join(dir, command);
  const content = template
    .replaceAll("__REAL_BIN__", realBin(realName))
    .replaceAll("__FILTER_JS__", filterJs)
    .replaceAll("__COMMAND__", command);
  writeFileSync(dest, content, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

// Creates a pass-through filter runner that echoes stdin
function writePassthroughFilter(dir: string): string {
  const dest = join(dir, "filter.mjs");
  const content = `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.resume();
`;
  writeFileSync(dest, content, "utf8");
  chmodSync(dest, 0o755);
  return dest;
}

function runWrapper(bin: string, args: string[], cwd: string): string {
  try {
    return execFileSync(bin, args, { cwd, encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`;
  }
}

describe("wrapper.sh with filter-runner passthrough", () => {
  let dir: string;
  let repo: string;
  let git: string;
  let filterJs: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aap-hook-"));
    repo = mkdtempSync(join(tmpdir(), "aap-repo-"));
    filterJs = writePassthroughFilter(dir);
    git = renderWrapper(dir, "git", "git", filterJs);
    const g = realBin("git");
    execFileSync(g, ["init", "-q"], { cwd: repo });
    execFileSync(g, ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync(g, ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hello\n");
    execFileSync(g, ["add", "."], { cwd: repo });
    execFileSync(g, ["commit", "-qm", "init"], { cwd: repo });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const ambiguous = /ambiguous argument|unknown revision/;

  it("log passes through", () => {
    const out = runWrapper(git, ["log"], repo);
    expect(out).not.toMatch(ambiguous);
    expect(out).toContain("init");
  });

  it("diff does not duplicate the subcommand", () => {
    writeFileSync(join(repo, "a.txt"), "hello world\n");
    const out = runWrapper(git, ["diff"], repo);
    expect(out).not.toMatch(ambiguous);
    expect(out).toContain("+hello world");
  });

  it("status still works and reports the modified file", () => {
    const out = runWrapper(git, ["status"], repo);
    expect(out).not.toMatch(ambiguous);
    expect(out).toContain("a.txt");
  });

  it("passes through unknown subcommands (rev-parse)", () => {
    const out = runWrapper(git, ["rev-parse", "--abbrev-ref", "HEAD"], repo);
    expect(out).not.toMatch(ambiguous);
    expect(out.trim().length).toBeGreaterThan(0);
  });
});

describe("wrapper.sh exit code propagation", () => {
  let dir: string;
  let ls: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aap-hook-rc-"));
    const filterJs = writePassthroughFilter(dir);
    ls = renderWrapper(dir, "ls", "ls", filterJs);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves exit code on success", () => {
    expect(() =>
      execFileSync(ls, ["-d", dir], { encoding: "utf8" }),
    ).not.toThrow();
  });

  it("preserves exit code on failure", () => {
    expect(() =>
      execFileSync(ls, ["/definitely/does/not/exist/path"], {
        encoding: "utf8",
      }),
    ).toThrow();
  });
});

describe("wrapper template substitution", () => {
  it("all placeholders are replaced", () => {
    const template = readFileSync(
      join(__dirname, "templates", "wrapper.sh"),
      "utf8",
    );
    expect(template).toContain("__REAL_BIN__");
    expect(template).toContain("__COMMAND__");
    expect(template).toContain("__FILTER_RUNNER__");

    const substituted = template
      .replaceAll("__REAL_BIN__", "/usr/bin/git")
      .replaceAll("__COMMAND__", "git")
      .replaceAll("__FILTER_RUNNER__", "/home/user/.aap/bin/aap-filter.mjs");

    expect(substituted).not.toContain("__REAL_BIN__");
    expect(substituted).not.toContain("__COMMAND__");
    expect(substituted).not.toContain("__FILTER_RUNNER__");
    expect(substituted).toContain("/usr/bin/git");
    expect(substituted).toContain("git");
    expect(substituted).toContain("/home/user/.aap/bin/aap-filter.mjs");
  });
});
