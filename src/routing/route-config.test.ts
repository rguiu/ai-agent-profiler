import { describe, expect, it } from "vitest";
import {
  claudeSettingsPatch,
  clientConfigPath,
  isRouted,
  mergeConfig,
  opencodeConfigPatch,
  piModelsPatch,
  providerBaseUrl,
} from "./route-config.js";

const ORIGIN = "http://127.0.0.1:8080";

const providers = {
  anthropic: { upstream: "https://api.anthropic.com" },
  openai: { upstream: "https://api.openai.com" },
  deepseek: { upstream: "https://api.deepseek.com" },
  bedrock: { upstream: "https://bedrock-runtime.eu-west-1.amazonaws.com" },
};

describe("providerBaseUrl", () => {
  it("lets Claude Code append its own /v1 path", () => {
    expect(
      providerBaseUrl(ORIGIN, "anthropic", providers.anthropic, false),
    ).toBe(`${ORIGIN}/anthropic`);
  });

  it("includes the provider api path for OpenAI-compatible clients", () => {
    expect(
      providerBaseUrl(ORIGIN, "anthropic", providers.anthropic, true),
    ).toBe(`${ORIGIN}/anthropic/v1`);
    expect(
      providerBaseUrl(
        ORIGIN,
        "deepseek",
        { upstream: "https://api.deepseek.com", apiPath: "/beta" },
        true,
      ),
    ).toBe(`${ORIGIN}/deepseek/beta`);
  });
});

describe("claudeSettingsPatch", () => {
  it("routes Anthropic, OpenAI and Bedrock in one settings file", () => {
    expect(claudeSettingsPatch(ORIGIN, providers)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: `${ORIGIN}/anthropic`,
        OPENAI_BASE_URL: `${ORIGIN}/openai`,
        ANTHROPIC_BEDROCK_BASE_URL: ORIGIN,
      },
    });
  });

  it("only routes the providers the config has", () => {
    expect(
      claudeSettingsPatch(ORIGIN, { anthropic: providers.anthropic }),
    ).toEqual({ env: { ANTHROPIC_BASE_URL: `${ORIGIN}/anthropic` } });
    expect(claudeSettingsPatch(ORIGIN, {})).toEqual({});
  });
});

describe("opencodeConfigPatch", () => {
  it("sets one baseURL per configured provider, api path included", () => {
    expect(opencodeConfigPatch(ORIGIN, providers)).toEqual({
      provider: {
        anthropic: { options: { baseURL: `${ORIGIN}/anthropic/v1` } },
        openai: { options: { baseURL: `${ORIGIN}/openai/v1` } },
        deepseek: { options: { baseURL: `${ORIGIN}/deepseek/v1` } },
        bedrock: { options: { baseURL: `${ORIGIN}/bedrock/v1` } },
      },
    });
  });
});

describe("piModelsPatch", () => {
  it("only touches provider ids pi already knows", () => {
    // deepseek/bedrock are configured in aap but are not built-in pi provider
    // ids: adding them without models/api would break pi's model list.
    expect(piModelsPatch(ORIGIN, providers)).toEqual({
      providers: {
        anthropic: { baseUrl: `${ORIGIN}/anthropic/v1` },
        openai: { baseUrl: `${ORIGIN}/openai/v1` },
      },
    });
  });
});

describe("mergeConfig", () => {
  it("keeps unrelated keys and existing provider settings", () => {
    const existing = {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["Bash(npm test)"] },
      env: { FOO: "bar" },
    };
    expect(
      mergeConfig(existing, { env: { ANTHROPIC_BASE_URL: ORIGIN } }),
    ).toEqual({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["Bash(npm test)"] },
      env: { FOO: "bar", ANTHROPIC_BASE_URL: ORIGIN },
    });
  });

  it("replaces scalars and arrays instead of merging them", () => {
    expect(mergeConfig({ a: [1, 2], b: "x" }, { a: [3] })).toEqual({
      a: [3],
      b: "x",
    });
  });

  it("builds a config from nothing", () => {
    expect(mergeConfig({}, { env: { A: "1" } })).toEqual({ env: { A: "1" } });
  });
});

describe("isRouted", () => {
  it("detects a config that already points at the proxy", () => {
    const routed = mergeConfig({}, claudeSettingsPatch(ORIGIN, providers));
    expect(isRouted("claude", routed, ORIGIN)).toBe(true);
    expect(isRouted("claude", { env: {} }, ORIGIN)).toBe(false);
    expect(
      isRouted(
        "claude",
        { env: { ANTHROPIC_BASE_URL: "https://x.dev" } },
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe("clientConfigPath", () => {
  it("uses each agent's user-level config file", () => {
    expect(clientConfigPath("claude", "/h")).toBe("/h/.claude/settings.json");
    expect(clientConfigPath("opencode", "/h")).toBe(
      "/h/.config/opencode/opencode.json",
    );
    expect(clientConfigPath("pi", "/h")).toBe("/h/.pi/agent/models.json");
  });
});
