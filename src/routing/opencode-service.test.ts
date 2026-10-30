import { describe, expect, it } from "vitest";
import {
  findRoutingHazards,
  formatRoutingHazards,
  proxySessionIds,
  withStandaloneArgs,
  type ServiceProbe,
} from "./opencode-service.js";

const ORIGIN = "http://127.0.0.1:8080";
const PROVIDERS = ["anthropic", "deepseek", "ollama-cloud"];

function config(baseURLs: Record<string, string>): string {
  const provider: Record<string, unknown> = {};
  for (const [name, url] of Object.entries(baseURLs)) {
    provider[name] = { options: { baseURL: url } };
  }
  return JSON.stringify({ provider });
}

function probe(services: Record<number, string>): ServiceProbe {
  return {
    listPids: () => Object.keys(services).map(Number),
    readEnv: (pid) => services[pid] ?? null,
  };
}

describe("withStandaloneArgs", () => {
  it("gives an interactive opencode launch a private server", () => {
    expect(withStandaloneArgs("opencode", [])).toEqual(["--standalone"]);
    expect(withStandaloneArgs("opencode", ["--auto"])).toEqual([
      "--standalone",
      "--auto",
    ]);
  });

  it("places --standalone after the subcommand", () => {
    expect(withStandaloneArgs("opencode", ["run", "hi"])).toEqual([
      "run",
      "--standalone",
      "hi",
    ]);
  });

  it("does not duplicate an explicit --standalone", () => {
    const args = ["run", "--standalone", "hi"];
    expect(withStandaloneArgs("opencode", args)).toEqual(args);
  });

  it("leaves an explicit --server alone", () => {
    expect(
      withStandaloneArgs("opencode", ["--server", "http://127.0.0.1:1"]),
    ).toEqual(["--server", "http://127.0.0.1:1"]);
    expect(
      withStandaloneArgs("opencode", ["--server=http://127.0.0.1:1"]),
    ).toEqual(["--server=http://127.0.0.1:1"]);
  });

  it("does not touch other agents", () => {
    expect(withStandaloneArgs("claude", [])).toEqual([]);
    expect(withStandaloneArgs("pi", ["run"])).toEqual(["run"]);
  });

  it("leaves non-launch subcommands alone", () => {
    expect(withStandaloneArgs("opencode", ["serve"])).toEqual(["serve"]);
    expect(withStandaloneArgs("opencode", ["session", "list"])).toEqual([
      "session",
      "list",
    ]);
    expect(withStandaloneArgs("opencode", ["models"])).toEqual(["models"]);
  });
});

describe("proxySessionIds", () => {
  it("reads the session id out of a launcher's base URLs", () => {
    const content = config({
      deepseek: `${ORIGIN}/b47c68b6/deepseek/v1`,
      anthropic: `${ORIGIN}/b47c68b6/anthropic/v1`,
    });
    expect(proxySessionIds(content, ORIGIN, PROVIDERS)).toEqual(["b47c68b6"]);
  });

  it("finds nothing in the wrapper-free config", () => {
    const content = config({
      deepseek: `${ORIGIN}/deepseek/v1`,
      anthropic: `${ORIGIN}/anthropic/v1`,
    });
    expect(proxySessionIds(content, ORIGIN, PROVIDERS)).toEqual([]);
  });

  it("ignores URLs outside the proxy", () => {
    const content = config({ deepseek: "https://api.deepseek.com/v1" });
    expect(proxySessionIds(content, ORIGIN, PROVIDERS)).toEqual([]);
  });

  it("does not confuse a different port for the proxy origin", () => {
    const content = config({
      deepseek: "http://127.0.0.1:80800/b47c/deepseek/v1",
    });
    expect(proxySessionIds(content, ORIGIN, PROVIDERS)).toEqual([]);
  });

  it("tolerates invalid JSON", () => {
    expect(proxySessionIds("{ not json", ORIGIN, PROVIDERS)).toEqual([]);
  });
});

describe("findRoutingHazards", () => {
  it("reports a launcher's routing in the current environment", () => {
    const env = {
      OPENCODE_CONFIG_CONTENT: config({
        deepseek: `${ORIGIN}/b47c/deepseek/v1`,
      }),
    };
    expect(
      findRoutingHazards({
        origin: ORIGIN,
        providers: PROVIDERS,
        env,
        probe: probe({}),
      }),
    ).toEqual([{ kind: "env", sessionIds: ["b47c"] }]);
  });

  it("reports a shared service still carrying a launcher's routing", () => {
    const hazards = findRoutingHazards({
      origin: ORIGIN,
      providers: PROVIDERS,
      env: {},
      probe: probe({
        13363: `opencode serve --service OPENCODE_CONFIG_CONTENT=${config({
          deepseek: `${ORIGIN}/b47c/deepseek/v1`,
        })}`,
        900: "opencode serve --service PATH=/usr/bin",
      }),
    });
    expect(hazards).toEqual([
      { kind: "service", pid: 13363, sessionIds: ["b47c"] },
    ]);
  });

  it("reads NUL-separated environments (Linux /proc)", () => {
    const hazards = findRoutingHazards({
      origin: ORIGIN,
      providers: PROVIDERS,
      env: {},
      probe: probe({
        42: `PATH=/usr/bin\0OPENCODE_CONFIG_CONTENT=${config({
          deepseek: `${ORIGIN}/b47c/deepseek/v1`,
        })}\0HOME=/tmp`,
      }),
    });
    expect(hazards).toEqual([
      { kind: "service", pid: 42, sessionIds: ["b47c"] },
    ]);
  });

  it("stays quiet for wrapper-free config and unrelated services", () => {
    expect(
      findRoutingHazards({
        origin: ORIGIN,
        providers: PROVIDERS,
        env: {
          OPENCODE_CONFIG_CONTENT: config({
            deepseek: `${ORIGIN}/deepseek/v1`,
          }),
        },
        probe: probe({ 900: "opencode serve --service PATH=/usr/bin" }),
      }),
    ).toEqual([]);
  });
});

describe("formatRoutingHazards", () => {
  it("tells the user how to clear a stale service", () => {
    const lines = formatRoutingHazards([
      { kind: "service", pid: 13363, sessionIds: ["b47c"] },
      { kind: "env", sessionIds: ["b47c"] },
    ]);
    const text = lines.join("\n");
    expect(text).toContain("pid 13363");
    expect(text).toContain("b47c");
    expect(text).toContain("opencode service stop");
    expect(text).toContain("OPENCODE_CONFIG_CONTENT");
  });

  it("prints nothing without hazards", () => {
    expect(formatRoutingHazards([])).toEqual([]);
  });
});
