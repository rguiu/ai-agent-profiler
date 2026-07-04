import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { computeCost, parseTrace, type TraceEvent } from "./parse.js";

function traceFor(
  contentType: string,
  body: Buffer,
  encoding?: string,
): TraceEvent[] {
  const headers: Record<string, string> = { "content-type": contentType };
  if (encoding) headers["content-encoding"] = encoding;
  return [
    { type: "request", headers: {} },
    { type: "response", status: 200, headers },
    { type: "response_body", data: body.toString("base64") },
    { type: "end" },
  ];
}

const ANTHROPIC_SSE = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":10,"output_tokens":1}}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"get_weather"}}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}`,
  ``,
  `event: message_stop`,
  `data: {"type":"message_stop"}`,
  ``,
].join("\n");

const OPENAI_SSE = [
  `data: {"object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}`,
  ``,
  `data: {"object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"search","arguments":""}}]},"finish_reason":null}]}`,
  ``,
  `data: {"object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  ``,
  `data: {"object":"chat.completion.chunk","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}`,
  ``,
  `data: [DONE]`,
  ``,
].join("\n");

const ANTHROPIC_JSON = JSON.stringify({
  type: "message",
  model: "claude-3-haiku",
  content: [
    { type: "text", text: "hi" },
    { type: "tool_use", id: "t", name: "lookup", input: {} },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 7 },
});

describe("parseTrace", () => {
  it("parses an Anthropic streaming response", () => {
    const result = parseTrace(
      traceFor("text/event-stream", Buffer.from(ANTHROPIC_SSE)),
    );
    expect(result.format).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(25);
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual(["get_weather"]);
    expect(result.streaming).toBe(true);
  });

  it("parses an OpenAI streaming response with usage", () => {
    const result = parseTrace(
      traceFor("text/event-stream", Buffer.from(OPENAI_SSE)),
    );
    expect(result.format).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(8);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual(["search"]);
    expect(result.streaming).toBe(true);
  });

  it("parses a non-streaming Anthropic JSON response", () => {
    const result = parseTrace(
      traceFor("application/json", Buffer.from(ANTHROPIC_JSON)),
    );
    expect(result.format).toBe("anthropic");
    expect(result.model).toBe("claude-3-haiku");
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(7);
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toEqual(["lookup"]);
    expect(result.streaming).toBe(false);
  });

  it("decompresses a gzip-encoded response", () => {
    const result = parseTrace(
      traceFor(
        "application/json",
        gzipSync(Buffer.from(ANTHROPIC_JSON)),
        "gzip",
      ),
    );
    expect(result.model).toBe("claude-3-haiku");
    expect(result.inputTokens).toBe(5);
  });

  it("returns unknown for an unrecognised body", () => {
    const result = parseTrace(
      traceFor("text/plain", Buffer.from("not a model response")),
    );
    expect(result.format).toBe("unknown");
    expect(result.model).toBeNull();
  });

  it("returns empty when there is no response body", () => {
    const result = parseTrace([{ type: "request" }, { type: "end" }]);
    expect(result.format).toBe("unknown");
    expect(result.toolCalls).toEqual([]);
  });
});

describe("computeCost", () => {
  const pricing = { "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 } };

  it("computes cost from token usage", () => {
    expect(computeCost("gpt-4o", 1_000_000, 1_000_000, pricing)).toBeCloseTo(
      12.5,
    );
  });

  it("returns null for an unpriced model", () => {
    expect(computeCost("mystery", 1000, 1000, pricing)).toBeNull();
  });

  it("returns null when the model is unknown", () => {
    expect(computeCost(null, 1000, 1000, pricing)).toBeNull();
  });
});
