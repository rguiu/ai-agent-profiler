import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  configCandidates,
  loadConfig,
  resolveConfigPath,
} from "./index.js";

const created: string[] = [];

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aap-config-"));
  created.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  let dir: string | undefined;
  while ((dir = created.pop())) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MINIMAL = `
[providers.anthropic]
upstream = "https://api.anthropic.com"
`;

describe("loadConfig", () => {
  it("loads providers and applies server defaults", () => {
    const config = loadConfig(writeConfig(MINIMAL), {});
    expect(config.server.port).toBe(8080);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.sessions.idleTimeoutMs).toBe(300_000);
    expect(config.providers.anthropic?.upstream).toBe(
      "https://api.anthropic.com",
    );
  });

  it("applies the AAP_PORT override", () => {
    const config = loadConfig(writeConfig(MINIMAL), { AAP_PORT: "9000" });
    expect(config.server.port).toBe(9000);
  });

  it("throws when no providers are configured", () => {
    expect(() =>
      loadConfig(writeConfig(`[server]\nport = 8080\n`), {}),
    ).toThrow(ConfigError);
  });

  it("throws on a missing file", () => {
    expect(() => loadConfig("/nonexistent/aap-config.toml", {})).toThrow(
      ConfigError,
    );
  });

  it("throws on an invalid upstream URL", () => {
    const bad = `
[providers.anthropic]
upstream = "not-a-url"
`;
    expect(() => loadConfig(writeConfig(bad), {})).toThrow(ConfigError);
  });

  it("throws on an invalid AAP_PORT", () => {
    expect(() => loadConfig(writeConfig(MINIMAL), { AAP_PORT: "abc" })).toThrow(
      ConfigError,
    );
  });

  it("throws on malformed TOML", () => {
    expect(() => loadConfig(writeConfig(`this is = = not toml`), {})).toThrow(
      ConfigError,
    );
  });
});

describe("config resolution", () => {
  it("uses AAP_CONFIG exclusively when set", () => {
    expect(configCandidates({ AAP_CONFIG: "/custom.toml" }, "/cwd")).toEqual([
      "/custom.toml",
    ]);
  });

  it("prefers the ~/.aap home config, then cwd", () => {
    expect(configCandidates({}, "/project", "/home")).toEqual([
      "/home/.aap/config.toml",
      "/project/config.toml",
    ]);
  });

  it("resolves the home config regardless of cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "aap-home-"));
    created.push(home);
    mkdirSync(join(home, ".aap"), { recursive: true });
    const global = join(home, ".aap", "config.toml");
    writeFileSync(global, MINIMAL);
    const emptyCwd = mkdtempSync(join(tmpdir(), "aap-cwd-"));
    created.push(emptyCwd);

    expect(resolveConfigPath({}, emptyCwd, home)).toBe(global);
  });

  it("returns null when no config exists", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "aap-home-"));
    created.push(emptyHome);
    const emptyCwd = mkdtempSync(join(tmpdir(), "aap-cwd-"));
    created.push(emptyCwd);
    expect(resolveConfigPath({}, emptyCwd, emptyHome)).toBeNull();
  });

  it("loadConfig throws a helpful error when nothing is found", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "aap-home-"));
    created.push(emptyHome);
    const emptyCwd = mkdtempSync(join(tmpdir(), "aap-cwd-"));
    created.push(emptyCwd);
    expect(() => loadConfig(undefined, {}, emptyCwd, emptyHome)).toThrow(
      /No config file found/,
    );
  });
});
