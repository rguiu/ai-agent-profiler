import { describe, expect, it } from "vitest";
import { parseRoute } from "./route.js";

const providers = new Set(["anthropic", "openai"]);
const withBedrock = new Set(["anthropic", "openai", "bedrock"]);
const withOllama = new Set(["anthropic", "openai", "ollama"]);

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

  it("routes Bedrock /model/ paths with active session", () => {
    expect(
      parseRoute(
        "/model/eu.anthropic.claude-opus-4-6-v1/converse-stream",
        withBedrock,
        "session-abc",
      ),
    ).toEqual({
      sessionId: "session-abc",
      provider: "bedrock",
      upstreamPath: "/model/eu.anthropic.claude-opus-4-6-v1/converse-stream",
    });
  });

  it("routes Bedrock /model/ paths without active session", () => {
    expect(parseRoute("/model/some-model/converse", withBedrock)).toEqual({
      sessionId: null,
      provider: "bedrock",
      upstreamPath: "/model/some-model/converse",
    });
  });

  it("does not route /model/ when bedrock provider is not configured", () => {
    expect(parseRoute("/model/some-model/converse", providers)).toBeNull();
  });

  it("routes session-scoped Bedrock paths from the path, not the global", () => {
    // The active-session fallback ("other-session") must be ignored when the
    // path carries its own session id — this is the concurrent-session fix.
    expect(
      parseRoute(
        "/aap-session/session-xyz/model/eu.anthropic.claude-opus-4-8/converse-stream",
        withBedrock,
        "other-session",
      ),
    ).toEqual({
      sessionId: "session-xyz",
      provider: "bedrock",
      upstreamPath: "/model/eu.anthropic.claude-opus-4-8/converse-stream",
    });
  });

  it("rejects an unsafe session id in a Bedrock path prefix", () => {
    // Falls through to the bare /model/ match (no /model/ here) → null.
    expect(
      parseRoute("/aap-session/bad id!/model/x/converse", withBedrock),
    ).toBeNull();
  });

  it("routes Ollama /api/ paths with active session", () => {
    expect(parseRoute("/api/chat", withOllama, null, "ollama-sid")).toEqual({
      sessionId: "ollama-sid",
      provider: "ollama",
      upstreamPath: "/api/chat",
    });
  });

  it("routes Ollama /api/ paths without active session", () => {
    expect(parseRoute("/api/generate", withOllama)).toEqual({
      sessionId: null,
      provider: "ollama",
      upstreamPath: "/api/generate",
    });
  });

  it("does not route /api/ when ollama provider is not configured", () => {
    expect(parseRoute("/api/chat", providers)).toBeNull();
  });

  it("rejects path-traversal session IDs", () => {
    expect(
      parseRoute("/../../etc/anthropic/v1/messages", providers),
    ).toBeNull();
    expect(parseRoute("/../foo/openai/v1/chat", providers)).toBeNull();
  });

  it("rejects session IDs with special characters", () => {
    expect(parseRoute("/foo bar/anthropic/v1/messages", providers)).toBeNull();
    expect(parseRoute("/foo%2F../anthropic/v1/messages", providers)).toBeNull();
  });
});
