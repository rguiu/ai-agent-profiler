import { describe, expect, it } from "vitest";
import { needsShaping, shapeRequestBody } from "./shape.js";

function parse(body: Buffer): Record<string, unknown> {
  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}

describe("needsShaping", () => {
  it("matches OpenAI-format chat-completions POSTs", () => {
    expect(needsShaping("deepseek", "POST", "/v1/chat/completions")).toBe(true);
    expect(needsShaping("openai", "post", "/chat/completions")).toBe(true);
    expect(
      needsShaping("deepseek", "POST", "/v1/chat/completions?stream=1"),
    ).toBe(true);
  });

  it("ignores other providers, methods, and paths", () => {
    expect(needsShaping("anthropic", "POST", "/v1/messages")).toBe(false);
    expect(needsShaping("bedrock", "POST", "/model/x/converse")).toBe(false);
    expect(needsShaping("deepseek", "GET", "/v1/chat/completions")).toBe(false);
    expect(needsShaping("deepseek", "POST", "/v1/completions")).toBe(false);
  });
});

describe("shapeRequestBody", () => {
  const args = ["deepseek", "POST", "/v1/chat/completions"] as const;

  it("injects stream_options.include_usage on streaming requests", () => {
    const body = Buffer.from(
      JSON.stringify({ model: "deepseek-chat", stream: true, messages: [] }),
    );
    const out = parse(shapeRequestBody(body, ...args));
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.model).toBe("deepseek-chat");
    expect(out.stream).toBe(true);
    expect(out.messages).toEqual([]);
  });

  it("preserves other stream_options fields", () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, stream_options: { foo: 1 } }),
    );
    const out = parse(shapeRequestBody(body, ...args));
    expect(out.stream_options).toEqual({ foo: 1, include_usage: true });
  });

  it("leaves the body untouched when include_usage is already true", () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, stream_options: { include_usage: true } }),
    );
    expect(shapeRequestBody(body, ...args)).toBe(body);
  });

  it("leaves non-streaming requests untouched", () => {
    const body = Buffer.from(JSON.stringify({ stream: false, messages: [] }));
    expect(shapeRequestBody(body, ...args)).toBe(body);
  });

  it("leaves non-OpenAI providers untouched", () => {
    const body = Buffer.from(JSON.stringify({ stream: true }));
    expect(shapeRequestBody(body, "anthropic", "POST", "/v1/messages")).toBe(
      body,
    );
  });

  it("fails open on non-JSON bodies", () => {
    const body = Buffer.from("not json");
    expect(shapeRequestBody(body, ...args)).toBe(body);
  });

  it("fails open on empty bodies", () => {
    const body = Buffer.alloc(0);
    expect(shapeRequestBody(body, ...args)).toBe(body);
  });

  it("updates the serialized length so content-length can be recomputed", () => {
    const body = Buffer.from(JSON.stringify({ stream: true }));
    const out = shapeRequestBody(body, ...args);
    expect(out.length).toBeGreaterThan(body.length);
  });
});
