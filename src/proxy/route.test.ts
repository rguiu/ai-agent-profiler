import { describe, expect, it } from "vitest";
import { parseRoute } from "./route.js";

const providers = new Set(["anthropic", "openai"]);

describe("parseRoute", () => {
  it("parses session + provider + path", () => {
    expect(parseRoute("/abc-123/anthropic/v1/messages", providers)).toEqual({
      sessionId: "abc-123",
      provider: "anthropic",
      upstreamPath: "/v1/messages",
    });
  });

  it("parses an unattributed route (provider first)", () => {
    expect(parseRoute("/anthropic/v1/messages", providers)).toEqual({
      sessionId: null,
      provider: "anthropic",
      upstreamPath: "/v1/messages",
    });
  });

  it("defaults to root when no upstream path remains", () => {
    expect(parseRoute("/session/openai", providers)).toEqual({
      sessionId: "session",
      provider: "openai",
      upstreamPath: "/",
    });
  });

  it("treats a bare provider as unattributed root", () => {
    expect(parseRoute("/openai", providers)).toEqual({
      sessionId: null,
      provider: "openai",
      upstreamPath: "/",
    });
  });

  it("returns null for an unknown provider after a session", () => {
    expect(parseRoute("/session/unknown/x", providers)).toBeNull();
  });

  it("returns null for an empty path", () => {
    expect(parseRoute("/", providers)).toBeNull();
  });

  it("preserves the exact remainder including extra slashes", () => {
    expect(parseRoute("/sid/openai/v1//foo", providers)?.upstreamPath).toBe(
      "/v1//foo",
    );
  });
});
