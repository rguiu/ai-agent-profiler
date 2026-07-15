import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  classifyRequestKind,
  computeCost,
  parseTrace,
  summarizeMessages,
  type TraceEvent,
} from "./parse.js";

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

  describe("prefix fingerprinting", () => {
    function eventsFor(requestBody: Record<string, unknown>): TraceEvent[] {
      return [
        { type: "request", headers: {} },
        {
          type: "request_body",
          data: Buffer.from(JSON.stringify(requestBody)).toString("base64"),
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
    }

    it("produces identical hashes for identical bodies", () => {
      const body = {
        system: "You are a helpful assistant",
        tools: [{ name: "read" }, { name: "write" }],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      };
      const a = parseTrace(eventsFor(body)).fingerprint;
      const b = parseTrace(eventsFor(body)).fingerprint;
      expect(a).toEqual(b);
      expect(a.messageHashes).toHaveLength(2);
    });

    it("keeps earlier messageHashes stable when a message is appended", () => {
      const base = {
        system: "sys",
        tools: [{ name: "read" }],
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
        ],
      };
      const appended = {
        ...base,
        messages: [...base.messages, { role: "user", content: "third" }],
      };
      const baseFp = parseTrace(eventsFor(base)).fingerprint;
      const appendedFp = parseTrace(eventsFor(appended)).fingerprint;
      expect(appendedFp.messageHashes.slice(0, 2)).toEqual(
        baseFp.messageHashes,
      );
      expect(appendedFp.messageHashes).toHaveLength(3);
      expect(appendedFp.systemHash).toBe(baseFp.systemHash);
      expect(appendedFp.toolsHash).toBe(baseFp.toolsHash);
    });

    it("changes toolsHash when tool order is reordered", () => {
      const body = (tools: unknown[]) => ({
        system: "sys",
        tools,
        messages: [{ role: "user", content: "hi" }],
      });
      const original = parseTrace(
        eventsFor(body([{ name: "read" }, { name: "write" }])),
      ).fingerprint;
      const reordered = parseTrace(
        eventsFor(body([{ name: "write" }, { name: "read" }])),
      ).fingerprint;
      expect(reordered.toolsHash).not.toBe(original.toolsHash);
    });

    it("changes systemHash when system text changes", () => {
      const body = (system: string) => ({
        system,
        tools: [{ name: "read" }],
        messages: [{ role: "user", content: "hi" }],
      });
      const a = parseTrace(eventsFor(body("You are helpful"))).fingerprint;
      const b = parseTrace(eventsFor(body("You are very helpful"))).fingerprint;
      expect(a.systemHash).not.toBe(b.systemHash);
    });
  });

  it("extracts DeepSeek prompt-cache hit tokens", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      model: "deepseek-chat",
      choices: [
        { index: 0, message: { role: "assistant" }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 100,
      },
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("openai");
    // inputTokens is fresh (non-cached): prompt_tokens 1000 - cache_hit 900 = 100 (= cache_miss)
    expect(result.inputTokens).toBe(100);
    expect(result.cachedInputTokens).toBe(900);
  });

  it("extracts OpenAI cached_tokens from prompt_tokens_details", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant" }, finish_reason: "stop" },
      ],
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

describe("summarizeMessages", () => {
  function requestTrace(body: unknown): TraceEvent[] {
    return [
      { type: "request", headers: { "content-type": "application/json" } },
      {
        type: "request_body",
        data: Buffer.from(JSON.stringify(body)).toString("base64"),
      },
      { type: "end" },
    ];
  }

  it("splits an OpenAI request body by role with sizes", () => {
    const stack = summarizeMessages(
      requestTrace({
        model: "gpt-4o",
        tools: [
          { type: "function", function: { name: "bash", parameters: {} } },
        ],
        messages: [
          { role: "system", content: "You are a helper." },
          { role: "user", content: "find the config" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "bash", arguments: '{"command":"ls"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "a.txt" },
        ],
      }),
    );
    expect(stack.model).toBe("gpt-4o");
    expect(stack.messageCount).toBe(4);
    expect(stack.tools.count).toBe(1);
    expect(stack.tools.tokens).toBeGreaterThan(0);
    expect(stack.totalBytes).toBeGreaterThan(0);
    const assistant = stack.messages.find((m) => m.role === "assistant");
    expect(assistant?.hasToolCalls).toBe(true);
    expect(assistant?.toolCallNames).toEqual(["bash"]);
    const tool = stack.messages.find((m) => m.role === "tool");
    expect(tool?.toolResultFor).toBe("c1");
  });

  it("classifies kind, focuses the last user message, and hashes messages", () => {
    const stack = summarizeMessages(
      requestTrace({
        model: "claude-opus-4-8",
        messages: [
          { role: "user", content: "do a thing" },
          { role: "assistant", content: "ok" },
          {
            role: "user",
            content:
              "The user stepped away. Provide a recap of what you were doing.",
          },
        ],
      }),
    );
    expect(stack.kind).toBe("recap");
    // lastUserIndex points at the recap instruction (index 2), not the earlier
    // user message.
    expect(stack.lastUserIndex).toBe(2);
    // Every message carries a stable content hash; identical role+text hash
    // equally, distinct text differs.
    const hashes = stack.messages.map((m) => m.hash);
    expect(hashes.every((h) => typeof h === "string" && h.length > 0)).toBe(
      true,
    );
    expect(new Set(hashes).size).toBe(3);
  });

  it("message hashes match the prefix fingerprint (diff invariant)", () => {
    // The request-detail "new vs previous" diff compares summarizeMessages
    // hashes against stored prefix-fingerprint hashes (parseTrace). They must
    // use the identical formula, incl. whitespace normalization, or every
    // message with a newline falsely reads as changed.
    const events = requestTrace({
      model: "claude",
      system: "You are\n\n  Claude.",
      messages: [
        { role: "user", content: "hello\n\tworld" },
        { role: "assistant", content: "hi   there" },
      ],
    });
    const fp = parseTrace(events).fingerprint.messageHashes;
    const summary = summarizeMessages(events)
      .messages.filter((m) => m.role !== "system")
      .map((m) => m.hash);
    expect(summary).toEqual(fp);
  });

  it("hashes a role-less message identically in both paths", () => {
    // Both hashMessage and MessageSummary.hash must fall back to the same
    // "unknown" role, or a message without a role false-flags as changed.
    const events = requestTrace({
      model: "claude",
      messages: [{ content: "no role here" }],
    });
    const fp = parseTrace(events).fingerprint.messageHashes;
    const summary = summarizeMessages(events).messages.map((m) => m.hash);
    expect(summary).toEqual(fp);
  });

  it("treats Anthropic top-level system as a synthetic message", () => {
    const stack = summarizeMessages(
      requestTrace({
        model: "claude-3-haiku",
        system: "You are Claude.",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "done" },
            ],
          },
        ],
      }),
    );
    expect(stack.messageCount).toBe(2);
    expect(stack.messages[0]?.role).toBe("system");
    expect(stack.messages[0]?.preview).toContain("Claude");
    expect(stack.messages[1]?.toolResultFor).toBe("t1");
  });

  it("returns an empty stack when there is no request body", () => {
    const stack = summarizeMessages([{ type: "request" }, { type: "end" }]);
    expect(stack.messageCount).toBe(0);
    expect(stack.messages).toEqual([]);
    expect(stack.tools.count).toBe(0);
  });
});

describe("Bedrock format", () => {
  it("parses a non-streaming Bedrock Converse response", () => {
    const response = {
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Hello!" },
            {
              toolUse: {
                toolUseId: "tu_1",
                name: "Read",
                input: { file_path: "/main.ts" },
              },
            },
          ],
        },
      },
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheReadInputTokens: 80,
      },
      stopReason: "tool_use",
    };
    const events: TraceEvent[] = [
      {
        type: "request",
        path: "/model/eu.anthropic.claude-opus-4-6-v1/converse",
      },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "application/json" },
      },
      {
        type: "response_body",
        data: Buffer.from(JSON.stringify(response)).toString("base64"),
      },
      { type: "end" },
    ];
    const result = parseTrace(events);
    expect(result.format).toBe("bedrock");
    expect(result.model).toBe("eu.anthropic.claude-opus-4-6-v1");
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(50);
    expect(result.cachedInputTokens).toBe(80);
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("Read");
    expect(result.toolCalls[0]?.id).toBe("tu_1");
    expect(result.toolCalls[0]?.arguments).toContain("/main.ts");
  });

  it("parses Bedrock streaming (binary event-stream with embedded JSON)", () => {
    // Simulate what embedded JSON looks like after binary frame stripping
    const events: unknown[] = [
      { messageStart: { role: "assistant" } },
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "tu_2", name: "Bash" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { input: '{"command":"ls"}' },
        },
      },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
      {
        metadata: {
          usage: {
            inputTokens: 300,
            outputTokens: 25,
            cacheReadInputTokens: 150,
          },
          metrics: { latencyMs: 1200 },
        },
      },
    ];
    // Embed JSON objects with some binary padding between them (simulating
    // the event-stream framing the extractor has to handle)
    const payload = Buffer.concat(
      events.map((e) => {
        const json = JSON.stringify(e);
        const padding = Buffer.alloc(12, 0xff);
        return Buffer.concat([padding, Buffer.from(json)]);
      }),
    );
    const traceEvents: TraceEvent[] = [
      {
        type: "request",
        path: "/model/eu.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream",
      },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      },
      { type: "response_body", data: payload.toString("base64") },
      { type: "end" },
    ];
    const result = parseTrace(traceEvents);
    expect(result.format).toBe("bedrock");
    expect(result.streaming).toBe(true);
    expect(result.model).toBe("eu.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(25);
    expect(result.cachedInputTokens).toBe(150);
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("Bash");
    expect(result.toolCalls[0]?.arguments).toBe('{"command":"ls"}');
  });

  it("extracts context from a Bedrock-format request body", () => {
    const reqBody = {
      system: [{ text: "You are a helpful assistant." }],
      messages: [
        { role: "user", content: [{ text: "hello" }] },
        {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "tu_1", name: "Read", input: {} } },
          ],
        },
        {
          role: "user",
          content: [
            {
              toolResult: { content: [{ text: "file contents here" }] },
              toolUseId: "tu_1",
            },
          ],
        },
      ],
      toolConfig: {
        tools: [
          { toolSpec: { name: "Read", description: "Read a file" } },
          { toolSpec: { name: "Bash", description: "Run a command" } },
        ],
      },
    };
    const events: TraceEvent[] = [
      { type: "request", path: "/model/m/converse", headers: {} },
      {
        type: "request_body",
        data: Buffer.from(JSON.stringify(reqBody)).toString("base64"),
      },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "application/json" },
      },
      {
        type: "response_body",
        data: Buffer.from(
          JSON.stringify({
            output: { message: { role: "assistant", content: [] } },
            usage: { inputTokens: 100, outputTokens: 10 },
            stopReason: "end_turn",
          }),
        ).toString("base64"),
      },
      { type: "end" },
    ];
    const result = parseTrace(events);
    expect(result.context.messageCount).toBe(3);
    expect(result.context.systemTokens).toBeGreaterThan(0);
    expect(result.context.toolsDefined).toBe(2);
    expect(result.context.toolsTokens).toBeGreaterThan(0);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.id).toBe("tu_1");
  });

  it("handles braces inside string values without corrupting depth", () => {
    // Bedrock event wrapping: the inner payload has braces in a string literal
    const innerEvent = {
      contentBlockDelta: {
        delta: { text: 'code: if (x) { return "{}" }' },
        contentBlockIndex: 0,
      },
    };
    const bedrockFrame = JSON.stringify({
      bytes: Buffer.from(JSON.stringify(innerEvent)).toString("base64"),
    });
    // Simulate multiple frames including one with confusing braces in text
    const metadataFrame = JSON.stringify({
      bytes: Buffer.from(
        JSON.stringify({
          messageStop: { stopReason: "end_turn" },
        }),
      ).toString("base64"),
    });
    const startFrame = JSON.stringify({
      bytes: Buffer.from(
        JSON.stringify({
          messageStart: {
            role: "assistant",
          },
        }),
      ).toString("base64"),
    });
    const metaFrame = JSON.stringify({
      bytes: Buffer.from(
        JSON.stringify({
          metadata: {
            usage: { inputTokens: 50, outputTokens: 10 },
            metrics: {},
          },
        }),
      ).toString("base64"),
    });
    // Binary padding between frames
    const payload = Buffer.from(
      `\x00\x00${startFrame}\x00\x00${bedrockFrame}\x00\x00${metadataFrame}\x00\x00${metaFrame}\x00`,
    );
    const events: TraceEvent[] = [
      { type: "request", path: "/model/m/converse-stream", headers: {} },
      {
        type: "response",
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      },
      { type: "response_body", data: payload.toString("base64") },
      { type: "end" },
    ];
    const result = parseTrace(events);
    expect(result.format).toBe("bedrock");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(10);
  });
});

describe("Ollama format", () => {
  function ndjson(objs: unknown[]): string {
    return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
  }

  it("parses an Ollama streaming chat response (NDJSON)", () => {
    const body = ndjson([
      {
        model: "llama3.2",
        message: { role: "assistant", content: "Hi" },
        done: false,
      },
      {
        model: "llama3.2",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "get_weather", arguments: { city: "NYC" } } },
          ],
        },
        done: false,
      },
      {
        model: "llama3.2",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 26,
        eval_count: 298,
      },
    ]);
    const result = parseTrace(
      traceFor("application/x-ndjson", Buffer.from(body)),
    );
    expect(result.format).toBe("ollama");
    expect(result.model).toBe("llama3.2");
    expect(result.inputTokens).toBe(26);
    expect(result.outputTokens).toBe(298);
    expect(result.stopReason).toBe("stop");
    expect(result.streaming).toBe(true);
    expect(result.toolCalls).toEqual([
      { id: "", name: "get_weather", arguments: '{"city":"NYC"}' },
    ]);
  });

  it("parses Ollama streaming NDJSON labelled application/json", () => {
    // The real Ollama daemon streams NDJSON but sets content-type
    // application/json, so the parser must fall back to NDJSON extraction.
    const body = ndjson([
      {
        model: "minimax-m3",
        message: { role: "assistant", content: "O" },
        done: false,
      },
      {
        model: "minimax-m3",
        message: { role: "assistant", content: "K" },
        done: false,
      },
      {
        model: "minimax-m3",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 12,
        eval_count: 3,
      },
    ]);
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("ollama");
    expect(result.model).toBe("minimax-m3");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(3);
    expect(result.stopReason).toBe("stop");
    expect(result.streaming).toBe(true);
  });

  it("parses a non-streaming Ollama chat response (JSON)", () => {
    const body = JSON.stringify({
      model: "llama3.2",
      message: { role: "assistant", content: "Hello" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 10,
      eval_count: 5,
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("ollama");
    expect(result.model).toBe("llama3.2");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
    expect(result.stopReason).toBe("stop");
    expect(result.streaming).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it("parses an Ollama /api/generate response", () => {
    const body = JSON.stringify({
      model: "llama3.2",
      response: "the answer",
      done: true,
      done_reason: "stop",
      prompt_eval_count: 8,
      eval_count: 12,
    });
    const result = parseTrace(traceFor("application/json", Buffer.from(body)));
    expect(result.format).toBe("ollama");
    expect(result.inputTokens).toBe(8);
    expect(result.outputTokens).toBe(12);
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

  it("applies cacheInputPerMTok for cached tokens", () => {
    const withCache = {
      "claude-sonnet-4-20250514": {
        inputPerMTok: 3.0,
        outputPerMTok: 15.0,
        cacheInputPerMTok: 0.3,
      },
    };
    // 500k fresh input, 500k cached read, 100k output
    const cost = computeCost(
      "claude-sonnet-4-20250514",
      500_000,
      100_000,
      withCache,
      500_000,
    );
    // fresh: 500k * 3/M = 1.5, cached: 500k * 0.3/M = 0.15, output: 100k * 15/M = 1.5
    expect(cost).toBeCloseTo(1.5 + 0.15 + 1.5);
  });

  it("falls back to inputPerMTok when cacheInputPerMTok is not set", () => {
    // Without cacheInputPerMTok, cached reads are charged at the full input rate
    const cost = computeCost("gpt-4o", 500_000, 0, pricing, 500_000);
    // fresh 500k + cached 500k, both at 2.5/M = 2.5
    expect(cost).toBeCloseTo(2.5);
  });

  it("prices Anthropic cache-creation (write) tokens at cacheWritePerMTok", () => {
    const opus = {
      "claude-opus-4": {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheInputPerMTok: 0.5,
        cacheWritePerMTok: 6.25,
      },
    };
    // 1k fresh, 10k cache read, 4k cache write, 2k output — all disjoint buckets
    const cost = computeCost(
      "claude-opus-4",
      1_000,
      2_000,
      opus,
      10_000,
      4_000,
    );
    expect(cost).toBeCloseTo(
      (1_000 * 5 + 10_000 * 0.5 + 4_000 * 6.25 + 2_000 * 25) / 1_000_000,
    );
  });

  it("prices a DeepSeek streaming response from its terminal usage chunk", () => {
    const deepseek = {
      "deepseek-chat": { inputPerMTok: 0.435, outputPerMTok: 0.87 },
    };
    const body = Buffer.from(
      sse([
        {
          object: "chat.completion.chunk",
          model: "deepseek-chat",
          choices: [{ index: 0, delta: { content: "ok" } }],
        },
        {
          object: "chat.completion.chunk",
          model: "deepseek-chat",
          choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        },
      ]) + "data: [DONE]\n\n",
    );
    const result = parseTrace(traceFor("text/event-stream", body));
    expect(result.model).toBe("deepseek-chat");
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    const cost = computeCost(
      result.model,
      result.inputTokens,
      result.outputTokens,
      deepseek,
    );
    expect(cost).toBeCloseTo((1000 / 1e6) * 0.435 + (500 / 1e6) * 0.87);
  });

  it("resolves prefixed and mixed-case model keys to the same rates", () => {
    const deepseek = {
      "deepseek-chat": { inputPerMTok: 0.435, outputPerMTok: 0.87 },
    };
    const base = computeCost("deepseek-chat", 1000, 500, deepseek);
    expect(computeCost("deepseek/deepseek-chat", 1000, 500, deepseek)).toBe(
      base,
    );
    expect(computeCost("DeepSeek-Chat", 1000, 500, deepseek)).toBe(base);
    expect(computeCost("provider/DeepSeek-Chat", 1000, 500, deepseek)).toBe(
      base,
    );
  });
});

describe("classifyRequestKind", () => {
  const SUB =
    "x-anthropic-billing-header: cc_version=2.1; cc_is_subagent=true;";

  it("splits the file-search subagent", () => {
    expect(
      classifyRequestKind(`${SUB} You are a file search specialist for Claude`),
    ).toBe("search");
  });

  it("splits the guide subagent", () => {
    expect(classifyRequestKind(`${SUB} You are the Claude guide agent.`)).toBe(
      "guide",
    );
  });

  it("splits the webfetch subagent (identity in the message body)", () => {
    expect(
      classifyRequestKind(
        `${SUB} You are Claude Code.`,
        "Web page content:\n---",
      ),
    ).toBe("webfetch");
  });

  it("falls back to generic subagent when identity is unknown", () => {
    expect(classifyRequestKind(`${SUB} You are Claude Code.`)).toBe("subagent");
  });

  it("detects the title-generation utility prompt", () => {
    expect(
      classifyRequestKind(
        "Generate a concise, sentence-case title (3-7 words) for this coding session.",
      ),
    ).toBe("title");
  });

  it("detects a recap from the last message", () => {
    expect(
      classifyRequestKind(
        "You are an interactive agent.",
        "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences.",
      ),
    ).toBe("recap");
  });

  it("detects compaction from the last message", () => {
    expect(
      classifyRequestKind(
        "You are an interactive agent.",
        "Provide a detailed summary of the conversation so far.",
      ),
    ).toBe("compact");
  });

  it("does NOT flag a normal turn whose history echoes an old summary", () => {
    // The phrase appears earlier in context but the last message is a real
    // instruction — must stay "main", not "compact".
    expect(
      classifyRequestKind(
        "You are an interactive agent that mentions detailed summary of the conversation.",
        "fix the failing test",
      ),
    ).toBe("main");
  });

  it("treats a normal interactive system prompt as main", () => {
    expect(
      classifyRequestKind("You are an interactive agent that helps users."),
    ).toBe("main");
  });

  it("returns unknown when there is no system prompt or last message", () => {
    expect(classifyRequestKind("")).toBe("unknown");
  });

  // OpenCode-specific markers

  it("detects OpenCode title agent from system prompt", () => {
    expect(
      classifyRequestKind(
        "You are a title generator. You output ONLY a thread title.",
      ),
    ).toBe("title");
  });

  it("detects OpenCode title from last message", () => {
    expect(
      classifyRequestKind(
        "You are opencode, an interactive CLI tool.",
        "Generate a title for this conversation:\n---",
      ),
    ).toBe("title");
  });

  it("detects OpenCode compaction agent from system prompt", () => {
    expect(
      classifyRequestKind(
        "You are an anchored context summarization assistant for coding sessions.",
      ),
    ).toBe("compact");
  });

  it("detects OpenCode compaction from last message template", () => {
    expect(
      classifyRequestKind(
        "You are opencode, an interactive CLI tool.",
        "Update the anchored summary below.\n## Objective\nFix the bug\n## Important Details\n- foo\n## Work State\n### Completed\n- bar",
      ),
    ).toBe("compact");
  });

  it("detects OpenCode explore/search agent without cc_is_subagent", () => {
    expect(
      classifyRequestKind(
        "You are a file search specialist. You excel at thoroughly navigating codebases.",
      ),
    ).toBe("search");
  });

  it("detects OpenCode summary agent as compact", () => {
    expect(
      classifyRequestKind(
        "Summarize what was done in this conversation. Write like a pull request description.",
      ),
    ).toBe("compact");
  });

  it("treats an OpenCode main prompt as main", () => {
    expect(
      classifyRequestKind(
        "You are opencode, an interactive CLI tool that helps users.",
      ),
    ).toBe("main");
  });

  it("detects OpenAI-format system messages in the messages array (integration)", () => {
    const events: TraceEvent[] = [
      { type: "request", headers: { "content-type": "application/json" } },
      {
        type: "request_body",
        data: Buffer.from(
          JSON.stringify({
            messages: [
              {
                role: "system",
                content:
                  "You are a file search specialist. You excel at navigating codebases.",
              },
              { role: "user", content: "find the auth module" },
            ],
          }),
        ).toString("base64"),
      },
      { type: "end" },
    ];
    expect(parseTrace(events).context.kind).toBe("search");
  });

  it("populates context.kind (recap) on a parsed trace", () => {
    const events: TraceEvent[] = [
      { type: "request", headers: { "content-type": "application/json" } },
      {
        type: "request_body",
        data: Buffer.from(
          JSON.stringify({
            system: [{ text: "You are Claude Code." }],
            messages: [
              { role: "user", content: "earlier turn" },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "The user stepped away and is coming back. Recap in under 40 words.",
                  },
                ],
              },
            ],
          }),
        ).toString("base64"),
      },
      { type: "end" },
    ];
    expect(parseTrace(events).context.kind).toBe("recap");
  });
});
