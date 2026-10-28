import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { route } from "./route.js";

const CONFIG = `
[server]
port = 1
host = "127.0.0.1"

[providers.anthropic]
upstream = "https://api.anthropic.com"
`;

let home: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aap-route-home-"));
  configPath = join(home, "config.toml");
  writeFileSync(configPath, CONFIG);
  saved.HOME = process.env.HOME;
  saved.AAP_CONFIG = process.env.AAP_CONFIG;
  process.env.HOME = home;
  process.env.AAP_CONFIG = configPath;
  // The patch reflects the ambient env; keep the test independent of the
  // developer's shell.
  delete process.env.ENABLE_TOOL_SEARCH;
  delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = saved.HOME;
  if (saved.AAP_CONFIG === undefined) delete process.env.AAP_CONFIG;
  else process.env.AAP_CONFIG = saved.AAP_CONFIG;
  rmSync(home, { recursive: true, force: true });
});

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

describe("aap route", () => {
  it("writes the client config and restores it on --undo", async () => {
    const settings = join(home, ".claude/settings.json");

    await route(["--write", "claude"]);
    const written = read(settings);
    expect(written.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1/anthropic",
      ENABLE_TOOL_SEARCH: "true",
    });

    await route(["--undo"]);
    // The file did not exist before, so undo removes it again.
    expect(existsSync(settings)).toBe(false);
  });

  it("merges into an existing config and restores the original on --undo", async () => {
    const settings = join(home, ".claude/settings.json");
    const original = {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["Bash(npm test)"] },
      env: { FOO: "bar" },
    };
    writeJson(settings, original);

    await route(["--write", "claude"]);
    expect(read(settings)).toEqual({
      ...original,
      env: {
        FOO: "bar",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1/anthropic",
        ENABLE_TOOL_SEARCH: "true",
      },
    });

    await route(["--undo"]);
    expect(read(settings)).toEqual(original);
  });

  it("is idempotent: writing twice keeps the pristine backup", async () => {
    const settings = join(home, ".claude/settings.json");
    await route(["--write", "claude"]);
    const first = readFileSync(settings, "utf8");

    await route(["--write", "claude"]);
    expect(readFileSync(settings, "utf8")).toBe(first);

    await route(["--undo"]);
    expect(existsSync(settings)).toBe(false);
  });

  it("refuses to touch a config file it cannot parse", async () => {
    const settings = join(home, ".claude/settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, "{ not json");

    await route(["--write", "claude"]);
    expect(readFileSync(settings, "utf8")).toBe("{ not json");
  });

  it("writes the optimisations and the 1h cache TTL", async () => {
    const settings = join(home, ".claude/settings.json");
    await route(["--write", "--cache-1h", "claude"]);
    expect(read(settings)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1/anthropic",
        ENABLE_TOOL_SEARCH: "true",
      },
      promptCacheTtl: "1h",
      subagentPromptCacheTtl: "1h",
    });
    await route(["--undo"]);
    expect(existsSync(settings)).toBe(false);
  });

  it("leaves a user's explicit opt-out alone", async () => {
    const settings = join(home, ".claude/settings.json");
    process.env.ENABLE_TOOL_SEARCH = "false";
    await route(["--write", "claude"]);
    expect(read(settings)).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/anthropic" },
    });
  });

  it("does nothing on --undo when nothing was applied", async () => {
    await expect(route(["--undo"])).resolves.toBeUndefined();
    expect(existsSync(join(home, ".claude/settings.json"))).toBe(false);
  });

  it("routes opencode and pi in their own config files", async () => {
    await route(["--write", "opencode", "pi"]);

    expect(read(join(home, ".config/opencode/opencode.json"))).toEqual({
      provider: {
        anthropic: { options: { baseURL: "http://127.0.0.1:1/anthropic/v1" } },
      },
    });
    expect(read(join(home, ".pi/agent/models.json"))).toEqual({
      providers: { anthropic: { baseUrl: "http://127.0.0.1:1/anthropic/v1" } },
    });

    await route(["--undo"]);
    expect(existsSync(join(home, ".config/opencode/opencode.json"))).toBe(
      false,
    );
    expect(existsSync(join(home, ".pi/agent/models.json"))).toBe(false);
  });
});
