import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./index.js";

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
