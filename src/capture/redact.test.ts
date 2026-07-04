import { describe, expect, it } from "vitest";
import { REDACTED, redactHeaders } from "./redact.js";

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
