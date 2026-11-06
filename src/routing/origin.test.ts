import { describe, expect, it } from "vitest";
import { clientHost, ollamaAliasHostname, proxyOrigin } from "./origin.js";

describe("clientHost", () => {
  it("turns a wildcard bind into a dialable loopback address", () => {
    expect(clientHost("0.0.0.0")).toBe("127.0.0.1");
    expect(clientHost("::")).toBe("127.0.0.1");
  });

  it("keeps a concrete address", () => {
    expect(clientHost("192.168.1.10")).toBe("192.168.1.10");
  });
});

describe("proxyOrigin", () => {
  it("uses the loopback form for a wildcard bind", () => {
    expect(proxyOrigin({ host: "0.0.0.0", port: 8080 })).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

describe("ollamaAliasHostname", () => {
  it("puts the session id under the reserved .localhost TLD", () => {
    expect(ollamaAliasHostname("abc-123")).toBe("abc-123.localhost");
  });

  it("gives each session its own name", () => {
    expect(ollamaAliasHostname("session-a")).not.toBe(
      ollamaAliasHostname("session-b"),
    );
  });

  it("is DNS-safe for ids that were valid session ids but not hostnames", () => {
    expect(ollamaAliasHostname("a_b")).toBe("a-b.localhost");
    expect(ollamaAliasHostname("UPPER")).toBe("upper.localhost");
  });

  it("never returns an empty label", () => {
    expect(ollamaAliasHostname("")).toBe("session.localhost");
  });
});
