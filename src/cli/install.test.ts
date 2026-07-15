import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install } from "./install.js";

const created: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-install-"));
  created.push(dir);
  return dir;
}

function writeExample(dir: string, content: string): string {
  const path = join(dir, "config.example.toml");
  writeFileSync(path, content);
  return path;
}

const EXAMPLE_MINIMAL = `
[server]
port = 8080
host = "127.0.0.1"

[storage]
dir = "data"

[providers.anthropic]
upstream = "https://api.anthropic.com"
`;

const EXAMPLE_EXTENDED = `
[server]
port = 8080
host = "127.0.0.1"

[sessions]
idleTimeoutMs = 300000

[storage]
dir = "data"

[throttle]
maxConcurrent = 8
maxQueued = 64

[providers.anthropic]
upstream = "https://api.anthropic.com"

[providers.openai]
upstream = "https://api.openai.com"
`;

afterEach(() => {
  let dir: string | undefined;
  while ((dir = created.pop())) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("install", () => {
  it("creates ~/.aap/ and seeds config when none exists", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_MINIMAL);
    const aapHome = join(home, ".aap");

    install({ home, examplePath });

    expect(existsSync(join(aapHome, "config.toml"))).toBe(true);
    expect(existsSync(join(aapHome, "data"))).toBe(true);

    const config = readFileSync(join(aapHome, "config.toml"), "utf8");
    expect(config).toContain("8080");
    expect(config).toContain("api.anthropic.com");
    // Storage dir should point to ~/.aap/data, not "data"
    expect(config).toContain(aapHome);
  });

  it("does not overwrite existing config", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_MINIMAL);
    const aapHome = join(home, ".aap");
    mkdirSync(aapHome, { recursive: true });

    const existingConfig = join(aapHome, "config.toml");
    const existingContent = `
[server]
port = 9999
host = "0.0.0.0"

[providers.anthropic]
upstream = "https://custom.example.com"
`;
    writeFileSync(existingConfig, existingContent);

    install({ home, examplePath });

    const config = readFileSync(existingConfig, "utf8");
    expect(config).toContain("9999");
    expect(config).toContain("custom.example.com");
  });

  it("merges new sections from example into existing config", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_EXTENDED);
    const aapHome = join(home, ".aap");
    mkdirSync(aapHome, { recursive: true });

    const existingConfig = join(aapHome, "config.toml");
    // Only has server and anthropic provider — missing sessions, throttle, openai
    writeFileSync(
      existingConfig,
      `
[server]
port = 3000

[providers.anthropic]
upstream = "https://api.anthropic.com"
`,
    );

    install({ home, examplePath });

    const config = readFileSync(existingConfig, "utf8");
    // Original values preserved
    expect(config).toContain("port = 3000");
    // New sections added
    expect(config).toContain("idleTimeoutMs");
    expect(config).toContain("maxConcurrent");
    expect(config).toContain("maxQueued");
    expect(config).toContain("api.openai.com");
    expect(config).toContain("# ADDED by aap install");
  });

  it("merges new fields within existing sections", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_EXTENDED);
    const aapHome = join(home, ".aap");
    mkdirSync(aapHome, { recursive: true });

    // Has [server] but only port, not host
    writeFileSync(
      join(aapHome, "config.toml"),
      `
[server]
port = 3000

[providers.anthropic]
upstream = "https://api.anthropic.com"
`,
    );

    install({ home, examplePath });

    const config = readFileSync(join(aapHome, "config.toml"), "utf8");
    expect(config).toContain("port = 3000");
    // host should be added
    expect(config.match(/host/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("reports up to date when nothing is missing", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_MINIMAL);
    const aapHome = join(home, ".aap");
    mkdirSync(aapHome, { recursive: true });

    writeFileSync(
      join(aapHome, "config.toml"),
      EXAMPLE_MINIMAL.replace(
        'dir = "data"',
        `dir = "${join(home, ".aap", "data")}"`,
      ),
    );

    install({ home, examplePath });

    const config = readFileSync(join(aapHome, "config.toml"), "utf8");
    expect(config).not.toContain("# ADDED by aap install");
  });

  it("handles new map entries within existing parent sections", () => {
    const home = tmpDir();
    const examples = tmpDir();
    const examplePath = writeExample(examples, EXAMPLE_EXTENDED);
    const aapHome = join(home, ".aap");
    mkdirSync(aapHome, { recursive: true });

    // Has providers.anthropic but not providers.openai
    writeFileSync(
      join(aapHome, "config.toml"),
      `
[server]
port = 8080

[providers.anthropic]
upstream = "https://api.anthropic.com"
`,
    );

    install({ home, examplePath });

    const config = readFileSync(join(aapHome, "config.toml"), "utf8");
    expect(config).toContain("api.openai.com");
  });

  it("fails gracefully when example config is not found", () => {
    const home = tmpDir();
    expect(() =>
      install({ home, examplePath: "/nonexistent/config.example.toml" }),
    ).toThrow();
  });
});
