import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../parse/index.js";
import { extractChunks, splitText, type ChunkSource } from "./extract.js";

const SOURCE: ChunkSource = {
  requestId: "req-1",
  sessionId: "sess-1",
  ts: "2026-07-17T10:00:00.000Z",
  model: "claude-sonnet-4",
  requestKind: "main",
  repo: "github.com/acme/widget",
  cwd: "/home/dev/widget",
  client: "claude",
};

function trace(
  requestBody: unknown,
  responseBody: unknown,
  opts: { status?: number; contentType?: string; sse?: boolean } = {},
): TraceEvent[] {
  const events: TraceEvent[] = [
    { type: "request", headers: { "content-type": "application/json" } },
  ];
  if (requestBody !== undefined) {
    events.push({
      type: "request_body",
      data: Buffer.from(JSON.stringify(requestBody)).toString("base64"),
    });
  }
  events.push({
    type: "response",
    status: opts.status ?? 200,
    headers: {
      "content-type":
        opts.contentType ??
        (opts.sse ? "text/event-stream" : "application/json"),
    },
  });
  if (responseBody !== undefined) {
    const raw = opts.sse
      ? (responseBody as unknown[])
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join("")
      : JSON.stringify(responseBody);
    events.push({
      type: "response_body",
      data: Buffer.from(raw).toString("base64"),
    });
  }
  events.push({ type: "end" });
  return events;
}

const ANTHROPIC_REQUEST = {
  model: "claude-sonnet-4",
  system: "You are a coding agent.",
  messages: [
    { role: "user", content: "Fix the ZMQ port race in the store" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look at the store first." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "Read",
          input: { file_path: "src/store.py" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [{ type: "text", text: "def bind(port): ..." }],
          is_error: false,
        },
      ],
    },
  ],
};

const ANTHROPIC_RESPONSE = {
  type: "message",
  model: "claude-sonnet-4",
  usage: { input_tokens: 100, output_tokens: 20 },
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "We chose advisory locks because they are safer." },
    {
      type: "tool_use",
      id: "tu_2",
      name: "Edit",
      input: { file_path: "src/store.py", old_string: "a", new_string: "b" },
    },
  ],
};

describe("splitText", () => {
  it("returns short text unchanged", () => {
    expect(splitText("hello")).toEqual(["hello"]);
  });

  it("splits long text on line boundaries deterministically", () => {
    const line = "x".repeat(100);
    const text = Array.from({ length: 100 }, () => line).join("\n");
    const a = splitText(text);
    const b = splitText(text);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    for (const part of a) expect(part.length).toBeLessThanOrEqual(4000);
    expect(a.join("\n")).toBe(text);
  });

  it("hard-splits single lines longer than the chunk size", () => {
    const parts = splitText("y".repeat(9000));
    expect(parts.length).toBe(3);
    expect(parts.join("")).toBe("y".repeat(9000));
  });

  it("caps runaway inputs at the part limit", () => {
    const parts = splitText("z".repeat(4000 * 100));
    expect(parts.length).toBeLessThanOrEqual(64);
  });
});

describe("extractChunks (anthropic)", () => {
  const events = trace(ANTHROPIC_REQUEST, ANTHROPIC_RESPONSE);
  const chunks = extractChunks(events, SOURCE);

  it("extracts the user prompt", () => {
    const prompts = chunks.filter((c) => c.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("ZMQ port race");
    expect(prompts[0]?.role).toBe("user");
  });

  it("extracts assistant text from history and response", () => {
    const responses = chunks.filter((c) => c.kind === "response");
    expect(responses.map((c) => c.text).join(" ")).toContain("advisory locks");
    expect(responses.map((c) => c.text).join(" ")).toContain(
      "look at the store",
    );
  });

  it("extracts tool calls with file paths from history and response", () => {
    const calls = chunks.filter((c) => c.kind === "tool_call");
    expect(calls.map((c) => c.toolName)).toEqual(["Read", "Edit"]);
    for (const call of calls) expect(call.filePath).toBe("src/store.py");
  });

  it("names tool results after the calling tool", () => {
    const results = chunks.filter((c) => c.kind === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.toolName).toBe("Read");
    expect(results[0]?.text).toContain("def bind");
    expect(results[0]?.isError).toBe(false);
  });

  it("skips the system prompt", () => {
    expect(chunks.some((c) => c.text.includes("coding agent"))).toBe(false);
  });

  it("produces stable uids and hashes across runs", () => {
    const again = extractChunks(
      trace(ANTHROPIC_REQUEST, ANTHROPIC_RESPONSE),
      SOURCE,
    );
    expect(again.map((c) => c.chunkUid)).toEqual(chunks.map((c) => c.chunkUid));
    expect(again.map((c) => c.contentHash)).toEqual(
      chunks.map((c) => c.contentHash),
    );
  });

  it("hashes identical content identically for cross-request dedup", () => {
    const other = extractChunks(trace(ANTHROPIC_REQUEST, ANTHROPIC_RESPONSE), {
      ...SOURCE,
      requestId: "req-2",
    });
    const hashes = new Set(chunks.map((c) => c.contentHash));
    for (const chunk of other) expect(hashes.has(chunk.contentHash)).toBe(true);
  });
});

describe("extractChunks (openai)", () => {
  const request = {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Why does the build fail?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            function: { name: "bash", arguments: '{"command":"npm test"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "1 test failed: TCPStore",
      },
    ],
  };
  const response = [
    {
      object: "chat.completion.chunk",
      model: "deepseek-chat",
      choices: [{ index: 0, delta: { content: "The failure is in " } }],
    },
    {
      object: "chat.completion.chunk",
      model: "deepseek-chat",
      choices: [{ index: 0, delta: { content: "TCPStore setup." } }],
    },
  ];
  const chunks = extractChunks(trace(request, response, { sse: true }), SOURCE);

  it("extracts prompt, tool call, tool result, and streamed response", () => {
    expect(
      chunks.some((c) => c.kind === "prompt" && c.text.includes("build fail")),
    ).toBe(true);
    const call = chunks.find((c) => c.kind === "tool_call");
    expect(call?.toolName).toBe("bash");
    expect(call?.text).toContain("npm test");
    const result = chunks.find((c) => c.kind === "tool_result");
    expect(result?.toolName).toBe("bash");
    expect(result?.text).toContain("TCPStore");
    const responseText = chunks
      .filter((c) => c.kind === "response")
      .map((c) => c.text)
      .join("");
    expect(responseText).toContain("The failure is in TCPStore setup.");
  });
});

describe("extractChunks (errors)", () => {
  it("captures trace error events", () => {
    const events: TraceEvent[] = [
      { type: "request", headers: {} },
      {
        type: "error",
        phase: "upstream",
        message: "socket hang up",
      } as TraceEvent,
      { type: "end" },
    ];
    const chunks = extractChunks(events, SOURCE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    expect(chunks[0]?.isError).toBe(true);
    expect(chunks[0]?.text).toBe("[upstream] socket hang up");
  });

  it("captures HTTP error response bodies", () => {
    const events = trace(
      { messages: [] },
      { error: { type: "overloaded_error", message: "Overloaded" } },
      { status: 529 },
    );
    const chunks = extractChunks(events, SOURCE);
    const error = chunks.find((c) => c.kind === "error");
    expect(error?.text).toContain("HTTP 529");
    expect(error?.text).toContain("Overloaded");
  });

  it("flags erroring tool results", () => {
    const request = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_9",
              content: "NullPointerException at line 42",
              is_error: true,
            },
          ],
        },
      ],
    };
    const chunks = extractChunks(trace(request, undefined), SOURCE);
    const result = chunks.find((c) => c.kind === "tool_result");
    expect(result?.isError).toBe(true);
  });
});
