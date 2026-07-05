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

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const ANTHROPIC_SSE = sse([
  {
    type: "message_start",
    message: {
      model: "claude-3-5-sonnet-20241022",
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "t1", name: "get_weather" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"location":"NYC"}' },
  },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 25 },
  },
  { type: "message_stop" },
]);

const OPENAI_SSE =
  sse([
    {
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "t1",
                function: { name: "search", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    {
      object: "chat.completion.chunk",
      model: "gpt-4o",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    },
  ]) + "data: [DONE]\n\n";

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
    expect(result.toolCalls).toEqual([
      { id: "t1", name: "get_weather", arguments: '{"location":"NYC"}' },
    ]);
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
    expect(result.toolCalls).toEqual([
      { id: "t1", name: "search", arguments: '{"q":"x"}' },
    ]);
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
    expect(result.toolCalls).toEqual([
      { id: "t", name: "lookup", arguments: "{}" },
    ]);
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

  it("extracts tool results and context from the request body", () => {
    const requestBody = JSON.stringify({
      system: "You are a helpful assistant",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "aaaa" },
          ],
        },
        { role: "tool", tool_call_id: "c2", content: "bbbbbb" },
      ],
      tools: [{ name: "read", description: "Read file" }, { name: "write" }],
    });
    const events: TraceEvent[] = [
      { type: "request", headers: {} },
      {
        type: "request_body",
        data: Buffer.from(requestBody).toString("base64"),
      },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "application/json" },
      },
      {
        type: "response_body",
        data: Buffer.from(ANTHROPIC_JSON).toString("base64"),
      },
      { type: "end" },
    ];
    const result = parseTrace(events);
    expect(result.toolResults).toEqual([
      { id: "t1", bytes: 4, tokens: 1 },
      { id: "c2", bytes: 6, tokens: 2 },
    ]);
    expect(result.context.messageCount).toBe(2);
    expect(result.context.systemTokens).toBeGreaterThan(0);
    expect(result.context.toolsDefined).toBe(2);
    expect(result.context.toolsTokens).toBeGreaterThan(0);
  });

  it("returns empty when there is no response body", () => {
    const result = parseTrace([{ type: "request" }, { type: "end" }]);
    expect(result.format).toBe("unknown");
    expect(result.toolCalls).toEqual([]);
  });

  it("extracts DeepSeek prompt-cache hit tokens", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      model: "deepseek-chat",
      choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 100,
      },
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("openai");
    expect(result.inputTokens).toBe(1000);
    expect(result.cachedInputTokens).toBe(900);
  });

  it("extracts OpenAI cached_tokens from prompt_tokens_details", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 500,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 256 },
      },
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.cachedInputTokens).toBe(256);
  });

  it("extracts Anthropic cache_read_input_tokens", () => {
    const body = JSON.stringify({
      type: "message",
      model: "claude-3-haiku",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 20,
        output_tokens: 7,
        cache_read_input_tokens: 1800,
      },
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("anthropic");
    expect(result.cachedInputTokens).toBe(1800);
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
