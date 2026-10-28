import { describe, expect, it } from "vitest";
import {
  buildOllamaClaudeEnv,
  fetchOllamaModels,
  toDaemonCloudName,
  parseOllamaArgs,
  planOllamaLaunch,
  resolveModelChoice,
  type FetchLike,
} from "./run-ollama.js";

const config = { providers: { anthropic: { upstream: "https://x.test" } } };

describe("parseOllamaArgs", () => {
  it("defaults to no agent, no model", () => {
    expect(parseOllamaArgs([])).toEqual({ agentArgs: [] });
  });

  it("reads --model before the agent and passes the rest through", () => {
    expect(parseOllamaArgs(["--model", "m1", "claude", "-p", "hi"])).toEqual({
      model: "m1",
      agent: "claude",
      agentArgs: ["-p", "hi"],
    });
  });

  it("supports --model=value", () => {
    expect(parseOllamaArgs(["--model=m2", "claude"]).model).toBe("m2");
  });

  it("leaves --model after the agent for the agent", () => {
    const p = parseOllamaArgs(["claude", "--model", "m3"]);
    expect(p.model).toBeUndefined();
    expect(p.agentArgs).toEqual(["--model", "m3"]);
  });
});

describe("buildOllamaClaudeEnv", () => {
  it("routes to ollama-cloud and pins all model tiers", () => {
    const env = buildOllamaClaudeEnv({
      origin: "http://localhost:8080",
      sessionId: "sid",
      apiKey: "k",
      model: "gpt-oss:120b",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe(
      "http://localhost:8080/sid/ollama-cloud",
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("k");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    // Left to buildAutoModeEnv, which respects an explicit user value.
    expect(env.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
    for (const k of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ]) {
      expect(env[k]).toBe("gpt-oss:120b");
    }
  });

  it("omits model vars when no model is set", () => {
    const env = buildOllamaClaudeEnv({
      origin: "http://h:1",
      sessionId: "s",
      apiKey: "k",
    });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });
});

describe("resolveModelChoice", () => {
  it("accepts a list number or a name", () => {
    expect(resolveModelChoice("2", ["a", "b"])).toBe("b");
    expect(resolveModelChoice(" custom:1 ", ["a"])).toBe("custom:1");
    expect(resolveModelChoice("  ", ["a"])).toBeUndefined();
  });
});

describe("fetchOllamaModels", () => {
  it("returns sorted names and sends the bearer key", async () => {
    let seen = "";
    const f: FetchLike = async (url, init) => {
      seen = `${url} ${init.headers.authorization}`;
      return {
        ok: true,
        json: async () => ({ models: [{ name: "b" }, { name: "a" }, {}] }),
      };
    };
    expect(await fetchOllamaModels("https://ollama.com/", "k", f)).toEqual([
      "a",
      "b",
    ]);
    expect(seen).toBe("https://ollama.com/api/tags Bearer k");
  });

  it("returns [] on failure", async () => {
    const f: FetchLike = async () => {
      throw new Error("down");
    };
    expect(await fetchOllamaModels("https://ollama.com", "k", f)).toEqual([]);
    const notOk: FetchLike = async () => ({
      ok: false,
      json: async () => ({}),
    });
    expect(await fetchOllamaModels("https://ollama.com", "k", notOk)).toEqual(
      [],
    );
  });
});

describe("planOllamaLaunch (non-interactive)", () => {
  const env = { OLLAMA_API_KEY: "k" } as NodeJS.ProcessEnv;

  it("plans claude with the given model and tags the session", async () => {
    const plan = await planOllamaLaunch(
      ["--model", "m", "claude", "-p", "hi"],
      env,
      config,
      "http://h:1",
      "sid",
      false,
    );
    expect(plan?.agent).toBe("claude");
    expect(plan?.agentArgs).toEqual(["-p", "hi"]);
    expect(plan?.meta).toEqual({ provider: "ollama-cloud", model: "m" });
  });

  it("fails without a key", async () => {
    expect(
      await planOllamaLaunch(
        ["--model", "m"],
        {},
        config,
        "http://h:1",
        "s",
        false,
      ),
    ).toBeNull();
  });

  it("fails without a model when not interactive", async () => {
    expect(
      await planOllamaLaunch([], env, config, "http://h:1", "s", false),
    ).toBeNull();
  });

  it("accepts a model passed to the agent itself", async () => {
    const plan = await planOllamaLaunch(
      ["claude", "--model", "m"],
      env,
      config,
      "http://h:1",
      "s",
      false,
    );
    expect(plan?.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(plan?.agentArgs).toEqual(["--model", "m"]);
  });

  it("rejects unsupported agents", async () => {
    expect(
      await planOllamaLaunch(["codex"], env, config, "http://h:1", "s", false),
    ).toBeNull();
  });

  describe("ollama launch agents", () => {
    const withDaemon = {
      providers: { ollama: { upstream: "http://127.0.0.1:11434" } },
    };

    it("plans `ollama launch pi` through the proxy without an API key", async () => {
      const plan = await planOllamaLaunch(
        ["--model", "m", "pi", "-p", "hi"],
        {},
        withDaemon,
        "http://h:1",
        "sid",
        false,
      );
      expect(plan?.agent).toBe("pi");
      expect(plan?.binary).toBe("ollama");
      expect(plan?.agentArgs).toEqual([
        "launch",
        "pi",
        "--model",
        "m",
        "--",
        "-p",
        "hi",
      ]);
      expect(plan?.env).toEqual({ OLLAMA_HOST: "http://h:1" });
      expect(plan?.meta).toEqual({
        provider: "ollama",
        launcher: "ollama-launch",
        model: "m",
      });
    });

    it("fails without a model when not interactive", async () => {
      expect(
        await planOllamaLaunch(
          ["opencode"],
          {},
          withDaemon,
          "http://h:1",
          "s",
          false,
        ),
      ).toBeNull();
    });

    it("accepts a --model after the agent without prompting", async () => {
      const plan = await planOllamaLaunch(
        ["pi", "--model", "glm-5.3-flash"],
        {},
        withDaemon,
        "http://h:1",
        "s",
        false,
      );
      expect(plan?.agentArgs).toEqual([
        "launch",
        "pi",
        "--",
        "--model",
        "glm-5.3-flash",
      ]);
      expect(plan?.model).toBeUndefined();
    });

    it("does not duplicate --standalone for opencode", async () => {
      const plan = await planOllamaLaunch(
        ["--model", "m", "opencode", "--standalone"],
        {},
        withDaemon,
        "http://h:1",
        "s",
        false,
      );
      expect(plan?.agentArgs).toEqual([
        "launch",
        "opencode",
        "--model",
        "m",
        "--",
        "--standalone",
      ]);
    });

    it("places --standalone after the `run` subcommand", async () => {
      const plan = await planOllamaLaunch(
        ["--model", "m", "opencode", "run", "--auto", "hi"],
        {},
        withDaemon,
        "http://h:1",
        "s",
        false,
      );
      expect(plan?.agentArgs).toEqual([
        "launch",
        "opencode",
        "--model",
        "m",
        "--",
        "run",
        "--standalone",
        "--auto",
        "hi",
      ]);
    });

    it("requires [providers.ollama]", async () => {
      expect(
        await planOllamaLaunch(["pi"], {}, config, "http://h:1", "s", false),
      ).toBeNull();
    });
  });
});

describe("toDaemonCloudName", () => {
  it("marks untagged and tagged cloud models for the daemon", () => {
    expect(toDaemonCloudName("glm-5.3-flash")).toBe("glm-5.3-flash:cloud");
    expect(toDaemonCloudName("gpt-oss:120b")).toBe("gpt-oss:120b-cloud");
    expect(toDaemonCloudName("kimi-k3:cloud")).toBe("kimi-k3:cloud");
  });
});
