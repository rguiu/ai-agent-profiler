import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Renders a template wrapper (substituting the real binary), runs it with the
// given args in `cwd`, and returns stdout+stderr. Exercises the ACTUAL bash
// branches — the double-subcommand bug (`git diff diff`) only shows up here,
// not in a unit test of install.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));

function realBin(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    return `/usr/bin/${name}`;
  }
}

function renderWrapper(
  dir: string,
  template: string,
  realName: string,
): string {
  const src = readFileSync(join(__dirname, "templates", template), "utf8");
  const dest = join(dir, template.replace(/\.sh$/, ""));
  writeFileSync(
    dest,
    src.replaceAll("__REAL_BIN__", realBin(realName)),
    "utf8",
  );
  chmodSync(dest, 0o755);
  return dest;
}

function runWrapper(bin: string, args: string[], cwd: string): string {
  try {
    return execFileSync(bin, args, { cwd, encoding: "utf8" });
  } catch (err) {
    // Some git subcommands (e.g. status with output) exit non-zero via the
    // pipeline; capture whatever was written.
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`;
  }
}

describe("git.sh wrapper branches", () => {
  let dir: string;
  let repo: string;
  let git: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aap-hook-"));
    repo = mkdtempSync(join(tmpdir(), "aap-repo-"));
    git = renderWrapper(dir, "git.sh", "git");
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

  // Regression guard: the bug was `__REAL_BIN__ diff "$@"` where $@ still held
  // the subcommand, producing `git diff diff` → "fatal: ambiguous argument".
  const ambiguous = /ambiguous argument|unknown revision/;

  it("log does not duplicate the subcommand", () => {
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

  it("show does not duplicate the subcommand", () => {
    const out = runWrapper(git, ["show", "HEAD"], repo);
    expect(out).not.toMatch(ambiguous);
    expect(out).toContain("init");
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
