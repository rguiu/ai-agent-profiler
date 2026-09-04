import { describe, expect, it } from "vitest";
import type { Config } from "../config/index.js";
import {
  buildProviderEnv,
  buildToolSearchEnv,
  isFirstPartyAnthropic,
  parseRunArgs,
  resolveSessionId,
} from "./run.js";

const providers: Pick<Config, "providers"> = {
  providers: {
    deepseek: { upstream: "https://api.deepseek.com" },
    anthropic: { upstream: "https://api.anthropic.com" },
    bedrock: { upstream: "https://bedrock-runtime.eu-west-1.amazonaws.com" },
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

  it("sets ANTHROPIC_BEDROCK_BASE_URL when CLAUDE_CODE_USE_BEDROCK=1", () => {
    const env = buildProviderEnv(
      "claude",
      providers,
      "http://localhost:8080",
      "sid1",
      { CLAUDE_CODE_USE_BEDROCK: "1" } as NodeJS.ProcessEnv,
    );
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBe("http://localhost:8080");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:8080/sid1/anthropic");
  });

  it("does not set bedrock endpoint when CLAUDE_CODE_USE_BEDROCK is unset", () => {
    const env = buildProviderEnv(
      "claude",
      providers,
      "http://localhost:8080",
      "sid1",
      {} as NodeJS.ProcessEnv,
    );
    expect(env.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
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

  it("sets OLLAMA_HOST for the ollama agent when configured", () => {
    const withOllama: Pick<Config, "providers"> = {
      providers: { ollama: { upstream: "https://ollama.com" } },
    };
    const env = buildProviderEnv(
      "ollama",
      withOllama,
      "http://localhost:8080",
      "sid1",
    );
    expect(env.OLLAMA_HOST).toBe("http://localhost:8080");
  });

  it("does not set OLLAMA_HOST when ollama provider is absent", () => {
    const env = buildProviderEnv(
      "ollama",
      providers,
      "http://localhost:8080",
      "sid1",
    );
    expect(env.OLLAMA_HOST).toBeUndefined();
  });

  it("does not set OLLAMA_HOST for non-ollama agents", () => {
    const withOllama: Pick<Config, "providers"> = {
      providers: { ollama: { upstream: "https://ollama.com" } },
    };
    const env = buildProviderEnv(
      "claude",
      withOllama,
      "http://localhost:8080",
      "sid1",
    );
    expect(env.OLLAMA_HOST).toBeUndefined();
  });
});

describe("parseRunArgs", () => {
  it("separates --meta flags from the agent command", () => {
    const { meta, agent, agentArgs } = parseRunArgs(
      ["--meta", "task=explain", "--meta", "iter=1", "opencode", "run", "hi"],
      {},
    );
    expect(meta).toEqual({ task: "explain", iter: "1" });
    expect(agent).toBe("opencode");
    expect(agentArgs).toEqual(["run", "hi"]);
  });

  it("captures AAP_META_* env vars and ARMADA_NODE_NAME", () => {
    const { meta } = parseRunArgs(["claude"], {
      AAP_META_TASK: "bugfix",
      ARMADA_NODE_NAME: "n3",
    });
    expect(meta.task).toBe("bugfix");
    expect(meta.armada_node).toBe("n3");
  });

  it("lets --meta flags override env meta", () => {
    const { meta } = parseRunArgs(["--meta", "task=b", "claude"], {
      AAP_META_TASK: "a",
    });
    expect(meta.task).toBe("b");
  });

  it("returns no agent when only flags are given", () => {
    expect(parseRunArgs(["--meta", "x=1"], {}).agent).toBeUndefined();
  });
});

describe("resolveSessionId", () => {
  it("honours a valid AAP_SESSION_ID", () => {
    expect(resolveSessionId({ AAP_SESSION_ID: "bench-fix-bug-1" })).toBe(
      "bench-fix-bug-1",
    );
  });

  it("generates a fresh id when unset or invalid", () => {
    expect(resolveSessionId({}).length).toBeGreaterThan(0);
    const bad = resolveSessionId({ AAP_SESSION_ID: "has spaces/and!" });
    expect(bad).not.toBe("has spaces/and!");
  });
});

describe("buildToolSearchEnv", () => {
  it("defaults ENABLE_TOOL_SEARCH=true for claude on a first-party Anthropic endpoint", () => {
    expect(buildToolSearchEnv("claude", {}, providers)).toEqual({
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("treats an *.anthropic.com enterprise endpoint as first-party", () => {
    const enterprise: Pick<Config, "providers"> = {
      providers: {
        anthropic: { upstream: "https://enterprise.anthropic.com" },
      },
    };
    expect(buildToolSearchEnv("claude", {}, enterprise)).toEqual({
      ENABLE_TOOL_SEARCH: "true",
    });
  });

  it("leaves ENABLE_TOOL_SEARCH unset for a non-Anthropic gateway", () => {
    const gateway: Pick<Config, "providers"> = {
      providers: {
        anthropic: { upstream: "https://openrouter.ai/api/v1" },
      },
    };
    expect(buildToolSearchEnv("claude", {}, gateway)).toEqual({});
  });

  it("leaves ENABLE_TOOL_SEARCH unset when no anthropic provider exists", () => {
    const deepseekOnly: Pick<Config, "providers"> = {
      providers: {
        deepseek: { upstream: "https://api.deepseek.com" },
      },
    };
    expect(buildToolSearchEnv("claude", {}, deepseekOnly)).toEqual({});
  });

  it("leaves ENABLE_TOOL_SEARCH unset for claude on Bedrock", () => {
    expect(
      buildToolSearchEnv("claude", { CLAUDE_CODE_USE_BEDROCK: "1" }, providers),
    ).toEqual({});
  });

  it("does not override an explicit ENABLE_TOOL_SEARCH", () => {
    expect(
      buildToolSearchEnv("claude", { ENABLE_TOOL_SEARCH: "false" }, providers),
    ).toEqual({});
    expect(
      buildToolSearchEnv("claude", { ENABLE_TOOL_SEARCH: "true" }, providers),
    ).toEqual({});
  });

  it("does not set ENABLE_TOOL_SEARCH for other agents", () => {
    expect(buildToolSearchEnv("opencode", {}, providers)).toEqual({});
  });

  it('leaves ENABLE_TOOL_SEARCH unset when the caller passes --tools "" (a tool-less call)', () => {
    expect(
      buildToolSearchEnv("claude", {}, providers, [
        "--print",
        "--tools",
        "",
        "--model",
        "sonnet",
      ]),
    ).toEqual({});
  });

  it("leaves ENABLE_TOOL_SEARCH unset for the --tools= form", () => {
    expect(
      buildToolSearchEnv("claude", {}, providers, ["--print", "--tools="]),
    ).toEqual({});
  });

  it("still defaults ENABLE_TOOL_SEARCH=true when --tools has a non-empty value", () => {
    expect(
      buildToolSearchEnv("claude", {}, providers, ["--tools", "Bash,Read"]),
    ).toEqual({ ENABLE_TOOL_SEARCH: "true" });
  });
});

describe("isFirstPartyAnthropic", () => {
  it("is true for api.anthropic.com", () => {
    expect(isFirstPartyAnthropic(providers, {})).toBe(true);
  });

  it("is true for an *.anthropic.com enterprise host", () => {
    const enterprise: Pick<Config, "providers"> = {
      providers: {
        anthropic: { upstream: "https://enterprise.anthropic.com" },
      },
    };
    expect(isFirstPartyAnthropic(enterprise, {})).toBe(true);
  });

  it("is false for a non-anthropic upstream host", () => {
    const gateway: Pick<Config, "providers"> = {
      providers: { anthropic: { upstream: "https://openrouter.ai" } },
    };
    expect(isFirstPartyAnthropic(gateway, {})).toBe(false);
  });

  it("is false when the anthropic provider is missing", () => {
    const deepseekOnly: Pick<Config, "providers"> = {
      providers: { deepseek: { upstream: "https://api.deepseek.com" } },
    };
    expect(isFirstPartyAnthropic(deepseekOnly, {})).toBe(false);
  });

  it("is false when Bedrock is in use", () => {
    expect(
      isFirstPartyAnthropic(providers, { CLAUDE_CODE_USE_BEDROCK: "1" }),
    ).toBe(false);
  });
});
