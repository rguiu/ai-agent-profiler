import { describe, expect, it } from "vitest";
import type { Config } from "../config/index.js";
import { buildProviderEnv } from "./run.js";

const providers: Pick<Config, "providers"> = {
  providers: {
    deepseek: { upstream: "https://api.deepseek.com" },
    anthropic: { upstream: "https://api.anthropic.com" },
  },
};

describe("buildProviderEnv", () => {
  it("routes opencode via OPENCODE_CONFIG_CONTENT with a /v1 base path", () => {
    const env = buildProviderEnv(
      "opencode",
      providers,
      "http://localhost:8080",
      "sid1",
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider: Record<string, { options: { baseURL: string } }>;
    };
    expect(config.provider.deepseek?.options.baseURL).toBe(
      "http://localhost:8080/sid1/deepseek/v1",
    );
    expect(config.provider.anthropic?.options.baseURL).toBe(
      "http://localhost:8080/sid1/anthropic/v1",
    );
  });

  it("sets base-URL env vars for Claude Code", () => {
    const env = buildProviderEnv(
      "claude",
      providers,
      "http://localhost:8080",
      "sid1",
    );
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:8080/sid1/anthropic");
  });

  it("respects a custom apiPath for opencode", () => {
    const custom: Pick<Config, "providers"> = {
      providers: {
        openrouter: { upstream: "https://openrouter.ai", apiPath: "/api/v1" },
      },
    };
    const env = buildProviderEnv("opencode", custom, "http://h:1", "s");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider: Record<string, { options: { baseURL: string } }>;
    };
    expect(config.provider.openrouter?.options.baseURL).toBe(
      "http://h:1/s/openrouter/api/v1",
    );
  });
});
