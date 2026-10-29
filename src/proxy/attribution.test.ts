import { describe, expect, it } from "vitest";
import {
  clientFromHeaders,
  sessionAliasFromHeaders,
  sessionIdFromHeaders,
} from "./attribution.js";

describe("sessionIdFromHeaders", () => {
  it("reads the session id Claude Code advertises", () => {
    expect(
      sessionIdFromHeaders({
        "x-claude-code-session-id": "3f2b8c1e-7a4d-4f0e-9a1b-2c3d4e5f6a7b",
      }),
    ).toBe("3f2b8c1e-7a4d-4f0e-9a1b-2c3d4e5f6a7b");
  });

  it("prefers x-aap-session over the client's own id", () => {
    expect(
      sessionIdFromHeaders({
        "x-aap-session": "benchmark-run-1",
        "x-claude-code-session-id": "native-id",
      }),
    ).toBe("benchmark-run-1");
  });

  it("reads opencode's root session id, not the subagent child", () => {
    expect(
      sessionIdFromHeaders({
        "x-opencode-session": "ses_root",
        "x-opencode-session-id": "ses_child",
      }),
    ).toBe("ses_root");
  });

  it("falls back to opencode's current session id when the root is absent", () => {
    expect(
      sessionIdFromHeaders({ "x-opencode-session-id": "ses_child" }),
    ).toBe("ses_child");
  });

  it("ignores ids that cannot be a trace directory", () => {
    expect(sessionIdFromHeaders({})).toBeNull();
    expect(
      sessionIdFromHeaders({ "x-claude-code-session-id": "../../etc/passwd" }),
    ).toBeNull();
    expect(
      sessionIdFromHeaders({ "x-claude-code-session-id": "has space" }),
    ).toBeNull();
    expect(
      sessionIdFromHeaders({ "x-claude-code-session-id": "x".repeat(200) }),
    ).toBeNull();
    expect(sessionIdFromHeaders({ "x-aap-session": "   " })).toBeNull();
  });
});

describe("clientFromHeaders", () => {
  it("maps the agents' user agents", () => {
    const cases: [string, string][] = [
      ["claude-cli/2.1.13 (external, cli)", "claude"],
      ["opencode/1.0.42", "opencode"],
      ["pi/1.4.0", "pi"],
      ["ollama/0.12.6 (aarch64 darwin)", "ollama-cli"],
      ["aws-sdk-js/3.600.0 ua/2.1 os/darwin", "aws-sdk"],
    ];
    for (const [ua, client] of cases) {
      expect(clientFromHeaders({ "user-agent": ua })).toBe(client);
    }
  });

  it("is unbothered by an unrecognised or missing user agent", () => {
    expect(clientFromHeaders({ "user-agent": "curl/8.7.1" })).toBeNull();
    expect(clientFromHeaders({})).toBeNull();
  });

  it("lets a client declare itself, which wins over the user agent", () => {
    expect(
      clientFromHeaders({
        "x-aap-client": "pi",
        "user-agent": "claude-cli/2.1.13 (external, cli)",
      }),
    ).toBe("pi");
  });

  it("rejects an unsafe x-aap-client value instead of storing it", () => {
    expect(
      clientFromHeaders({ "x-aap-client": "bad client", "user-agent": "pi/1" }),
    ).toBe("pi");
  });
});

describe("sessionAliasFromHeaders", () => {
  it("reads the per-session name aap run dialled", () => {
    expect(
      sessionAliasFromHeaders({
        host: "e1b2e1bb-2235-45bc-becc-d6edcf2d04ad.localhost:8080",
      }),
    ).toBe("e1b2e1bb-2235-45bc-becc-d6edcf2d04ad.localhost");
  });

  it("ignores the shared address", () => {
    expect(sessionAliasFromHeaders({ host: "127.0.0.1:8080" })).toBeNull();
    expect(sessionAliasFromHeaders({ host: "localhost:8080" })).toBeNull();
  });

  it("ignores hosts that are not .localhost names", () => {
    expect(sessionAliasFromHeaders({ host: "example.com:8080" })).toBeNull();
    expect(sessionAliasFromHeaders({ host: "192.168.1.5:8080" })).toBeNull();
    expect(sessionAliasFromHeaders({})).toBeNull();
  });

  it("normalises case, since hostnames are case-insensitive", () => {
    expect(sessionAliasFromHeaders({ host: "ABC.localhost:8080" })).toBe(
      "abc.localhost",
    );
  });
});
