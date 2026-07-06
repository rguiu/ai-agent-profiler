import { describe, expect, it } from "vitest";
import { REDACTED, redactHeaders, redactUrl } from "./redact.js";

describe("redactHeaders", () => {
  it("redacts sensitive headers, preserves the rest", () => {
    const out = redactHeaders({
      authorization: "Bearer secret",
      "x-api-key": "sk-123",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    expect(out["authorization"]).toBe(REDACTED);
    expect(out["x-api-key"]).toBe(REDACTED);
    expect(out["content-type"]).toBe("application/json");
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("redacts x-goog-api-key", () => {
    const out = redactHeaders({ "x-goog-api-key": "AIza..." });
    expect(out["x-goog-api-key"]).toBe(REDACTED);
  });

  it("is case-insensitive on header names", () => {
    expect(redactHeaders({ Authorization: "Bearer x" })["Authorization"]).toBe(
      REDACTED,
    );
  });

  it("drops undefined values", () => {
    const out = redactHeaders({ "x-present": "yes", "x-absent": undefined });
    expect(out).toEqual({ "x-present": "yes" });
  });
});

describe("redactUrl", () => {
  it("returns URL unchanged when no query params", () => {
    expect(redactUrl("/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("redacts sensitive query params", () => {
    const url = "/v1/models?api_key=sk-secret&format=json";
    const result = redactUrl(url);
    expect(result).toContain("api_key=%5BREDACTED%5D");
    expect(result).toContain("format=json");
    expect(result).not.toContain("sk-secret");
  });

  it("redacts key and token params", () => {
    expect(redactUrl("/api?key=abc123")).toContain("key=%5BREDACTED%5D");
    expect(redactUrl("/api?token=xyz")).toContain("token=%5BREDACTED%5D");
    expect(redactUrl("/api?access_token=t")).toContain(
      "access_token=%5BREDACTED%5D",
    );
  });

  it("preserves non-sensitive params", () => {
    const url = "/v1/models?model=gpt-4&stream=true";
    expect(redactUrl(url)).toBe(url);
  });
});
