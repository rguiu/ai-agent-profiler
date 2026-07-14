import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface TraceEvent {
  type: string;
  data?: string;
  headers?: Record<string, string | string[]>;
  status?: number;
  [key: string]: unknown;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ParsedToolResult {
  id: string;
  bytes: number;
  tokens: number;
}

// What triggered a request. "main" is the user-driven interactive loop; every
// other kind is an agent-initiated (non-user) call whose cost we want to break
// out separately. Detected from the request body — see classifyRequestKind.
//
// Subagent flavours (all carry cc_is_subagent=true in the billing header):
//   search   — the file-search/Explore specialist grepping the repo
//   guide    — the Claude docs/help agent answering "how do I…"
//   webfetch — summarising fetched web-page content
//   subagent — a subagent we couldn't further identify
//
// recap/compact/title/quota run on the main model with a normal system prompt;
// their trigger is in the LAST message, not the system block:
//   recap    — "The user stepped away…": a short mid-session catch-up summary
//   compact  — full-history summarisation for context compaction
export type RequestKind =
  | "main"
  | "subagent"
  | "search"
  | "guide"
  | "webfetch"
  | "title"
  | "compact"
  | "recap"
  | "quota"
  | "unknown";

export interface ParsedContext {
  messageCount: number;
  systemTokens: number;
  toolsDefined: number;
  toolsTokens: number;
  kind: RequestKind;
}

export interface ParsedTrace {
  format: "anthropic" | "openai" | "bedrock" | "ollama" | "unknown";
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  context: ParsedContext;
  streaming: boolean;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheInputPerMTok?: number;
  cacheWritePerMTok?: number;
}

interface Extract {
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  toolCalls: ParsedToolCall[];
}

function emptyExtract(): Extract {
  return {
    model: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
    stopReason: null,
    toolCalls: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function headerValue(
  headers: Record<string, string | string[]> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function decompress(body: Buffer, encoding: string | null): Buffer {
  if (!encoding) return body;
  const enc = encoding.toLowerCase();
  try {
    if (enc.includes("gzip")) return gunzipSync(body);
    if (enc.includes("br")) return brotliDecompressSync(body);
    if (enc.includes("deflate")) return inflateSync(body);
  } catch {
    return body;
  }
  return body;
}

function extractSSE(text: string): unknown[] {
  const objects: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      objects.push(JSON.parse(payload));
    } catch {
      // skip malformed SSE data line
    }
  }
  return objects;
}

// Ollama streams responses as newline-delimited JSON (application/x-ndjson):
// one complete JSON object per line, no "data:" prefix.
function extractNDJSON(text: string): unknown[] {
  const objects: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      // skip malformed NDJSON line
    }
  }
  return objects;
}

// AWS Bedrock uses a binary event-stream format. Each frame contains a JSON
// payload that we can extract by scanning for JSON objects in the raw bytes.
// The scanner is string-aware: braces inside JSON string literals don't affect
// depth tracking.
function extractBedrockEvents(buf: Buffer): unknown[] {
  const objects: unknown[] = [];
  const text = buf.toString("utf8");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as Record<
            string,
            unknown
          >;
          // Bedrock wraps Anthropic Messages API responses in {"bytes":"<base64>"}
          if (typeof obj.bytes === "string") {
            try {
              objects.push(
                JSON.parse(Buffer.from(obj.bytes, "base64").toString("utf8")),
              );
            } catch {
              objects.push(obj);
            }
          } else {
            objects.push(obj);
          }
        } catch {
          // not valid JSON — skip
        }
        start = -1;
      }
    }
  }
  return objects;
}

function parseWholeJson(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    return [];
  }
}

function looksAnthropic(objects: unknown[]): boolean {
  return objects.some((o) => {
    const r = asRecord(o);
    if (!r) return false;
    return (
      r.type === "message_start" ||
      r.type === "message" ||
      r.type === "message_delta" ||
      r.type === "content_block_start"
    );
  });
}

function looksOpenAI(objects: unknown[]): boolean {
  return objects.some((o) => {
    const r = asRecord(o);
    if (!r) return false;
    const object = asString(r.object);
    if (object?.startsWith("chat.completion")) return true;
    const usage = asRecord(r.usage);
    return usage?.["prompt_tokens"] !== undefined;
  });
}

function looksBedrock(objects: unknown[]): boolean {
  return objects.some((o) => {
    const r = asRecord(o);
    if (!r) return false;
    return (
      r.messageStart !== undefined ||
      r.messageStop !== undefined ||
      r.contentBlockStart !== undefined ||
      r.contentBlockDelta !== undefined ||
      r.metadata !== undefined ||
      (r.output !== undefined && r.stopReason !== undefined)
    );
  });
}

// Ollama native responses carry a boolean `done` and either a chat `message`
// object or a `/api/generate` `response` string. No `type`/`usage`/`choices`
// fields, so this never collides with the anthropic/openai/bedrock detectors.
function looksOllama(objects: unknown[]): boolean {
  return objects.some((o) => {
    const r = asRecord(o);
    if (!r) return false;
    if (typeof r.done !== "boolean") return false;
    return asRecord(r.message) !== null || typeof r.response === "string";
  });
}

function applyAnthropicMessage(
  message: Record<string, unknown>,
  acc: Extract,
): void {
  const model = asString(message.model);
  if (model) acc.model = model;
  const usage = asRecord(message.usage);
  if (usage) {
    const input = asNumber(usage.input_tokens);
    if (input !== null) acc.inputTokens = input;
    const output = asNumber(usage.output_tokens);
    if (output !== null) acc.outputTokens = output;
    const cached = asNumber(usage.cache_read_input_tokens);
    if (cached !== null) acc.cachedInputTokens = cached;
    const creation = asNumber(usage.cache_creation_input_tokens);
    if (creation !== null) acc.cacheCreationTokens = creation;
  }
  const stop = asString(message.stop_reason);
  if (stop) acc.stopReason = stop;
  for (const block of asArray(message.content)) {
    const record = asRecord(block);
    if (record?.type === "tool_use") {
      const name = asString(record.name);
      if (name) {
        const input = asRecord(record.input);
        acc.toolCalls.push({
          id: asString(record.id) ?? "",
          name,
          arguments: input ? JSON.stringify(input) : "",
        });
      }
    }
  }
}

function parseAnthropic(objects: unknown[]): Extract {
  const acc = emptyExtract();
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    switch (record.type) {
      case "message_start": {
        const message = asRecord(record.message);
        if (message) applyAnthropicMessage(message, acc);
        break;
      }
      case "message":
        applyAnthropicMessage(record, acc);
        break;
      case "message_delta": {
        const delta = asRecord(record.delta);
        const stop = delta ? asString(delta.stop_reason) : null;
        if (stop) acc.stopReason = stop;
        const usage = asRecord(record.usage);
        const output = usage ? asNumber(usage.output_tokens) : null;
        if (output !== null) acc.outputTokens = output;
        break;
      }
      case "content_block_start": {
        const index = asNumber(record.index);
        const block = asRecord(record.content_block);
        if (block?.type === "tool_use" && index !== null) {
          const name = asString(block.name) ?? "";
          const input = asRecord(block.input);
          byIndex.set(index, {
            id: asString(block.id) ?? "",
            name,
            args:
              input && Object.keys(input).length > 0
                ? JSON.stringify(input)
                : "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const index = asNumber(record.index);
        const delta = asRecord(record.delta);
        if (index !== null && delta?.type === "input_json_delta") {
          const fragment = asString(delta.partial_json) ?? "";
          const entry = byIndex.get(index);
          if (entry) entry.args += fragment;
        }
        break;
      }
    }
  }
  for (const [, entry] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    acc.toolCalls.push({
      id: entry.id,
      name: entry.name,
      arguments: entry.args,
    });
  }
  return acc;
}

function parseBedrock(objects: unknown[]): Extract {
  const acc = emptyExtract();
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;

    // Non-streaming Converse response
    if (record.output !== undefined) {
      const output = asRecord(record.output);
      const message = output ? asRecord(output.message) : null;
      if (message) {
        for (const block of asArray(message.content)) {
          const b = asRecord(block);
          if (!b) continue;
          const toolUse = asRecord(b.toolUse);
          if (toolUse) {
            const name = asString(toolUse.name);
            if (name) {
              acc.toolCalls.push({
                id: asString(toolUse.toolUseId) ?? "",
                name,
                arguments: toolUse.input ? JSON.stringify(toolUse.input) : "",
              });
            }
          }
        }
      }
      acc.stopReason = asString(record.stopReason) ?? acc.stopReason;
      const usage = asRecord(record.usage);
      if (usage) {
        acc.inputTokens = asNumber(usage.inputTokens);
        acc.outputTokens = asNumber(usage.outputTokens);
        acc.cachedInputTokens = asNumber(usage.cacheReadInputTokens);
        acc.cacheCreationTokens = asNumber(usage.cacheWriteInputTokens);
      }
      continue;
    }

    // Streaming: contentBlockStart
    const blockStart = asRecord(record.contentBlockStart);
    if (blockStart) {
      const index = asNumber(blockStart.contentBlockIndex);
      const start = asRecord(blockStart.start);
      const toolUse = start ? asRecord(start.toolUse) : null;
      if (toolUse && index !== null) {
        byIndex.set(index, {
          id: asString(toolUse.toolUseId) ?? "",
          name: asString(toolUse.name) ?? "",
          args: "",
        });
      }
      continue;
    }

    // Streaming: contentBlockDelta
    const blockDelta = asRecord(record.contentBlockDelta);
    if (blockDelta) {
      const index = asNumber(blockDelta.contentBlockIndex);
      const delta = asRecord(blockDelta.delta);
      if (index !== null && delta) {
        const entry = byIndex.get(index);
        if (entry) {
          const fragment = asString(delta.input);
          if (fragment) entry.args += fragment;
        }
      }
      continue;
    }

    // Streaming: messageStop
    const messageStop = asRecord(record.messageStop);
    if (messageStop) {
      acc.stopReason = asString(messageStop.stopReason) ?? acc.stopReason;
      continue;
    }

    // Streaming: metadata (comes last, contains usage)
    const metadata = asRecord(record.metadata);
    if (metadata) {
      const usage = asRecord(metadata.usage);
      if (usage) {
        acc.inputTokens = asNumber(usage.inputTokens);
        acc.outputTokens = asNumber(usage.outputTokens);
        acc.cachedInputTokens = asNumber(usage.cacheReadInputTokens);
        acc.cacheCreationTokens = asNumber(usage.cacheWriteInputTokens);
      }
      continue;
    }
  }

  for (const [, entry] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    acc.toolCalls.push({
      id: entry.id,
      name: entry.name,
      arguments: entry.args,
    });
  }

  // Extract model from the request path (Bedrock embeds it in the URL)
  return acc;
}

function openAICachedTokens(usage: Record<string, unknown>): number | null {
  const hit = asNumber(usage.prompt_cache_hit_tokens);
  if (hit !== null) return hit;
  const details = asRecord(usage.prompt_tokens_details);
  if (details) return asNumber(details.cached_tokens);
  return null;
}

function parseOpenAI(objects: unknown[]): Extract {
  const acc = emptyExtract();
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  const noIndex: ParsedToolCall[] = [];

  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    const model = asString(record.model);
    if (model) acc.model = model;
    const usage = asRecord(record.usage);
    if (usage) {
      const output = asNumber(usage.completion_tokens);
      if (output !== null) acc.outputTokens = output;
      const cached = openAICachedTokens(usage);
      if (cached !== null) acc.cachedInputTokens = cached;
      // OpenAI/DeepSeek report prompt_tokens as the TOTAL prompt (cached
      // included). Normalise to fresh (non-cached) so the stored input_tokens
      // means the same thing across providers and computeCost needs no subtraction.
      const promptTotal = asNumber(usage.prompt_tokens);
      if (promptTotal !== null) acc.inputTokens = promptTotal - (cached ?? 0);
    }
    for (const choice of asArray(record.choices)) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) continue;
      const finish = asString(choiceRecord.finish_reason);
      if (finish) acc.stopReason = finish;
      const container =
        asRecord(choiceRecord.delta) ?? asRecord(choiceRecord.message);
      if (!container) continue;
      for (const toolCall of asArray(container.tool_calls)) {
        const toolRecord = asRecord(toolCall);
        if (!toolRecord) continue;
        const fn = asRecord(toolRecord.function);
        const name = fn ? asString(fn.name) : null;
        const argFragment = fn ? asString(fn.arguments) : null;
        const id = asString(toolRecord.id);
        const index = asNumber(toolRecord.index);
        if (index !== null) {
          let entry = byIndex.get(index);
          if (!entry) {
            entry = { id: "", name: "", args: "" };
            byIndex.set(index, entry);
          }
          if (id) entry.id = id;
          if (name) entry.name = name;
          if (argFragment) entry.args += argFragment;
        } else if (name) {
          noIndex.push({ id: id ?? "", name, arguments: argFragment ?? "" });
        }
      }
    }
  }

  acc.toolCalls =
    byIndex.size > 0
      ? [...byIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, entry]) => ({
            id: entry.id,
            name: entry.name,
            arguments: entry.args,
          }))
      : noIndex;
  return acc;
}

function parseOllama(objects: unknown[]): Extract {
  const acc = emptyExtract();
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    const model = asString(record.model);
    if (model) acc.model = model;
    const promptEval = asNumber(record.prompt_eval_count);
    if (promptEval !== null) acc.inputTokens = promptEval;
    const evalCount = asNumber(record.eval_count);
    if (evalCount !== null) acc.outputTokens = evalCount;
    const doneReason = asString(record.done_reason);
    if (doneReason) acc.stopReason = doneReason;
    const message = asRecord(record.message);
    if (!message) continue;
    // Ollama emits complete tool calls (arguments as an object, no id/index),
    // not the fragmented deltas OpenAI streaming uses.
    for (const call of asArray(message.tool_calls)) {
      const callRecord = asRecord(call);
      if (!callRecord) continue;
      const fn = asRecord(callRecord.function);
      const name = fn ? asString(fn.name) : null;
      if (!name) continue;
      acc.toolCalls.push({
        id: asString(callRecord.id) ?? "",
        name,
        arguments:
          fn && fn.arguments !== undefined ? JSON.stringify(fn.arguments) : "",
      });
    }
  }
  return acc;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Extract only the human/prompt TEXT of a message, ignoring tool_result and
// other structured blocks. Used for kind classification: recap/compaction
// instructions arrive as plain text, and a tool_result echoing those phrases
// (e.g. captured command output) must not trigger a false positive.
function lastMessagePromptText(content: unknown): string {
  const asStr = asString(content);
  if (asStr !== null) return asStr;
  let out = "";
  for (const block of asArray(content)) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type !== undefined && record.type !== "text") continue;
    const text = asString(record.text);
    if (text !== null) out += text;
  }
  return out;
}

function extractResultText(content: unknown): string {
  const asStr = asString(content);
  if (asStr !== null) return asStr;
  let out = "";
  for (const block of asArray(content)) {
    const record = asRecord(block);
    if (!record) continue;
    const text = asString(record.text);
    out += text !== null ? text : JSON.stringify(block);
  }
  return out;
}

function parseRequestJson(
  events: TraceEvent[],
): Record<string, unknown> | null {
  const requestEvent = events.find((e) => e.type === "request");
  const chunks = events
    .filter((e) => e.type === "request_body" && typeof e.data === "string")
    .map((e) => Buffer.from(e.data as string, "base64"));
  if (chunks.length === 0) return null;
  const body = decompress(
    Buffer.concat(chunks),
    headerValue(requestEvent?.headers, "content-encoding"),
  );
  try {
    return asRecord(JSON.parse(body.toString("utf8")));
  } catch {
    return null;
  }
}

// Classify what triggered a request. Two signal sources:
//   1. The SYSTEM PROMPT (top-level system field + role:"system" messages) —
//      carries provider-specific markers: Claude's cc_is_subagent billing header
//      and OpenCode's per-agent prompt identities (title, compaction, explore).
//   2. The LAST message — recap/compaction/quota run on the MAIN model with a
//      normal system prompt, so they're only distinguishable by their final
//      instruction ("The user stepped away…", "detailed summary…").
// `lastMessageText` is the text of the final message (any role); pass "" when
// unavailable. Classifying from the last message (not the whole transcript)
// avoids false positives from prior summaries echoed back in history.
export function classifyRequestKind(
  systemText: string,
  lastMessageText = "",
): RequestKind {
  const last = lastMessageText.toLowerCase();
  // Recap: a short mid-session catch-up the client injects as the last user
  // message. Runs on the main model, so only the instruction identifies it.
  if (last.includes("the user stepped away") && last.includes("recap")) {
    return "recap";
  }
  // Compaction: full-history summarisation. The instruction is the last
  // message; matching it there (not anywhere in history) prevents a prior
  // summary echoed into context from mislabelling a normal turn.
  if (
    last.includes("summary of the conversation") ||
    last.includes("detailed summary of our conversation") ||
    last.includes("create a detailed summary")
  ) {
    return "compact";
  }

  if (!systemText) return "unknown";
  const s = systemText.toLowerCase();
  // Subagents carry cc_is_subagent=true. Split by their specialist identity so
  // the file-search agent (the tunable cost driver) is visible on its own.
  if (/cc_is_subagent\s*=\s*true/.test(s)) {
    if (s.includes("file search specialist")) return "search";
    if (s.includes("claude guide agent")) return "guide";
    // WebFetch's identity is in the message body ("Web page content:"), not the
    // system prompt, so check the last message here too.
    if (last.includes("web page content")) return "webfetch";
    return "subagent";
  }

  // Claude Code title-gen: "Generate a concise… title" + "session"
  if (
    s.includes("generate a concise") &&
    s.includes("title") &&
    s.includes("session")
  ) {
    return "title";
  }

  // OpenCode agents — distinct per-agent system prompts carry the identity.
  // Title agent: "You are a title generator. You output ONLY a thread title."
  if (
    s.includes("you are a title generator") ||
    last.includes("generate a title for this conversation")
  ) {
    return "title";
  }
  // Compaction agent: "You are an anchored context summarization assistant…"
  if (
    s.includes("you are an anchored context summarization") ||
    (last.includes("## objective") &&
      last.includes("## important details") &&
      last.includes("## work state"))
  ) {
    return "compact";
  }
  // Explore agent (file search): "You are a file search specialist…"
  // Matches OpenCode's explore agent without requiring cc_is_subagent.
  if (s.includes("you are a file search specialist")) return "search";
  // Summary agent: "Summarize what was done in this conversation."
  if (s.includes("summarize what was done in this conversation")) {
    return "compact";
  }

  if (s.includes("quota") || s.includes("usage limit")) return "quota";
  return "main";
}

function parseRequestBody(events: TraceEvent[]): {
  toolResults: ParsedToolResult[];
  context: ParsedContext;
} {
  const empty = {
    toolResults: [] as ParsedToolResult[],
    context: {
      messageCount: 0,
      systemTokens: 0,
      toolsDefined: 0,
      toolsTokens: 0,
      kind: "unknown" as RequestKind,
    },
  };

  const record = parseRequestJson(events);
  if (!record) return empty;

  const messages = asArray(record.messages);
  const toolResults: ParsedToolResult[] = [];
  const add = (id: string | null, content: unknown): void => {
    if (!id) return;
    const text = extractResultText(content);
    toolResults.push({
      id,
      bytes: Buffer.byteLength(text),
      tokens: estimateTokens(text),
    });
  };

  // Handle system prompt: Anthropic uses string/array, Bedrock uses [{text:"..."}]
  let systemText = "";
  const systemField = record.system;
  if (typeof systemField === "string") {
    systemText = systemField;
  } else if (Array.isArray(systemField)) {
    for (const item of systemField) {
      const rec = asRecord(item);
      if (rec) {
        const text = asString(rec.text);
        systemText += text ?? extractResultText(rec.content ?? "");
      } else if (typeof item === "string") {
        systemText += item;
      }
    }
  }
  const lastMessage = asRecord(messages[messages.length - 1]);
  const lastMessageText = lastMessage
    ? lastMessagePromptText(lastMessage.content)
    : "";

  // Accumulate system messages from the messages array — OpenAI/DeepSeek format
  // carries system instructions inside role:"system" entries rather than a
  // top-level system field. Process these BEFORE classification so the
  // classifier can see provider-agnostic markers (title, compact, search).
  for (const message of messages) {
    const msg = asRecord(message);
    if (!msg) continue;
    const role = asString(msg.role);
    if (role === "system" || role === "developer") {
      systemText += extractResultText(msg.content);
    }
    if (role === "tool") {
      add(asString(msg.tool_call_id), msg.content);
      continue;
    }
    for (const block of asArray(msg.content)) {
      const blockRecord = asRecord(block);
      if (!blockRecord) continue;
      if (blockRecord.type === "tool_result") {
        add(asString(blockRecord.tool_use_id), blockRecord.content);
      }
      // Bedrock format: toolResult instead of tool_result
      const toolResult = asRecord(blockRecord.toolResult);
      if (toolResult) {
        add(asString(blockRecord.toolUseId), toolResult.content);
      }
    }
  }

  // Classify now that we have both the top-level system field (Anthropic) and
  // any role:"system" messages from the array (OpenAI/DeepSeek). Using the last
  // message ONLY (not the whole transcript) avoids false positives from prior
  // summaries echoed back into context.
  const kind = classifyRequestKind(systemText, lastMessageText);

  // Tools: Anthropic uses record.tools, Bedrock uses record.toolConfig.tools
  let tools = asArray(record.tools);
  if (tools.length === 0) {
    const toolConfig = asRecord(record.toolConfig);
    if (toolConfig) tools = asArray(toolConfig.tools);
  }
  const context: ParsedContext = {
    messageCount: messages.length,
    systemTokens: estimateTokens(systemText),
    toolsDefined: tools.length,
    toolsTokens: tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0,
    kind,
  };
  return { toolResults, context };
}

export interface MessageSummary {
  index: number;
  role: string;
  bytes: number;
  tokens: number;
  hasToolCalls: boolean;
  toolCallNames: string[];
  toolResultFor: string | null;
  preview: string;
}

export interface RoleTotal {
  role: string;
  count: number;
  bytes: number;
  tokens: number;
}

export interface MessageStack {
  model: string | null;
  messageCount: number;
  totalBytes: number;
  totalTokens: number;
  tools: { count: number; bytes: number; tokens: number };
  totalsByRole: RoleTotal[];
  messages: MessageSummary[];
}

// Break a captured request body into its per-message composition (role, size,
// token estimate, tool-call/result links) so the UI can show exactly what is
// re-sent on each call. Derived on the fly from the stored trace — no storage.
export function summarizeMessages(events: TraceEvent[]): MessageStack {
  const empty: MessageStack = {
    model: null,
    messageCount: 0,
    totalBytes: 0,
    totalTokens: 0,
    tools: { count: 0, bytes: 0, tokens: 0 },
    totalsByRole: [],
    messages: [],
  };

  const record = parseRequestJson(events);
  if (!record) return empty;

  const toolsArr = asArray(record.tools);
  const toolsJson = toolsArr.length > 0 ? JSON.stringify(toolsArr) : "";
  const tools = {
    count: toolsArr.length,
    bytes: Buffer.byteLength(toolsJson),
    tokens: toolsArr.length > 0 ? estimateTokens(toolsJson) : 0,
  };

  const raw: Record<string, unknown>[] = [];
  const systemText = extractResultText(record.system ?? "");
  if (systemText) raw.push({ role: "system", content: systemText });
  for (const message of asArray(record.messages)) {
    const msg = asRecord(message);
    if (msg) raw.push(msg);
  }

  const totals = new Map<string, RoleTotal>();
  let totalBytes = 0;
  let totalTokens = 0;
  const messages: MessageSummary[] = raw.map((msg, index) => {
    const serialized = JSON.stringify(msg);
    const bytes = Buffer.byteLength(serialized);
    const tokens = estimateTokens(serialized);
    const role = asString(msg.role) ?? "unknown";

    const toolCallNames: string[] = [];
    for (const call of asArray(msg.tool_calls)) {
      const fn = asRecord(asRecord(call)?.function);
      const name = fn ? asString(fn.name) : null;
      if (name) toolCallNames.push(name);
    }
    let toolResultFor = asString(msg.tool_call_id);
    for (const block of asArray(msg.content)) {
      const b = asRecord(block);
      if (b?.type === "tool_use") {
        const name = asString(b.name);
        if (name) toolCallNames.push(name);
      } else if (b?.type === "tool_result") {
        toolResultFor = asString(b.tool_use_id) ?? toolResultFor;
      }
    }

    totalBytes += bytes;
    totalTokens += tokens;
    const acc = totals.get(role) ?? { role, count: 0, bytes: 0, tokens: 0 };
    acc.count += 1;
    acc.bytes += bytes;
    acc.tokens += tokens;
    totals.set(role, acc);

    return {
      index,
      role,
      bytes,
      tokens,
      hasToolCalls: toolCallNames.length > 0,
      toolCallNames,
      toolResultFor: toolResultFor ?? null,
      preview: extractResultText(msg.content)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200),
    };
  });

  return {
    model: asString(record.model),
    messageCount: messages.length,
    totalBytes,
    totalTokens,
    tools,
    totalsByRole: [...totals.values()],
    messages,
  };
}

// Extract the model ID from a Bedrock request path like /model/{id}/converse-stream
function extractBedrockModel(events: TraceEvent[]): string | null {
  const req = events.find((e) => e.type === "request");
  if (!req) return null;
  const path = asString((req as Record<string, unknown>).path);
  if (!path) return null;
  const match = path.match(/\/model\/([^/]+)\//);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function parseTrace(events: TraceEvent[]): ParsedTrace {
  const { toolResults, context } = parseRequestBody(events);
  const base: ParsedTrace = {
    format: "unknown",
    model: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
    stopReason: null,
    toolCalls: [],
    toolResults,
    context,
    streaming: false,
  };

  const responseEvent = events.find((e) => e.type === "response");
  const chunks = events
    .filter((e) => e.type === "response_body" && typeof e.data === "string")
    .map((e) => Buffer.from(e.data as string, "base64"));
  if (chunks.length === 0) return base;

  const body = decompress(
    Buffer.concat(chunks),
    headerValue(responseEvent?.headers, "content-encoding"),
  );
  const contentType = headerValue(responseEvent?.headers, "content-type") ?? "";
  const text = body.toString("utf8");
  const isBinaryEventStream = contentType.includes(
    "application/vnd.amazon.eventstream",
  );
  const isNdjson = contentType.includes("x-ndjson");
  const isSSE =
    contentType.includes("text/event-stream") ||
    text.startsWith("data:") ||
    text.startsWith("event:");

  let objects: unknown[];
  let ndjsonStream = false;
  if (isBinaryEventStream) {
    objects = extractBedrockEvents(body);
  } else if (isNdjson) {
    objects = extractNDJSON(text);
  } else if (isSSE) {
    objects = extractSSE(text);
  } else {
    objects = parseWholeJson(text);
    // Ollama streams newline-delimited JSON but labels it application/json.
    // When the body is not a single JSON value, fall back to NDJSON parsing.
    if (objects.length === 0) {
      const lines = extractNDJSON(text);
      if (lines.length > 0) {
        objects = lines;
        ndjsonStream = lines.length > 1;
      }
    }
  }
  const streaming = isBinaryEventStream || isNdjson || isSSE || ndjsonStream;
  if (objects.length === 0) return { ...base, streaming };

  if (looksAnthropic(objects)) {
    const extracted = parseAnthropic(objects);
    // When Anthropic events arrive via Bedrock binary event-stream, prefer the
    // full model ID from the URL path (e.g. eu.anthropic.claude-opus-4-6-v1)
    // over the shortened name in the response body.
    const model = isBinaryEventStream
      ? (extractBedrockModel(events) ?? extracted.model)
      : extracted.model;
    return {
      ...extracted,
      model,
      format: "anthropic",
      toolResults,
      context,
      streaming,
    };
  }
  if (looksOpenAI(objects)) {
    return {
      ...parseOpenAI(objects),
      format: "openai",
      toolResults,
      context,
      streaming,
    };
  }
  if (looksBedrock(objects)) {
    const extracted = parseBedrock(objects);
    return {
      ...extracted,
      model: extracted.model ?? extractBedrockModel(events),
      format: "bedrock",
      toolResults,
      context,
      streaming,
    };
  }
  if (looksOllama(objects)) {
    return {
      ...parseOllama(objects),
      format: "ollama",
      toolResults,
      context,
      streaming,
    };
  }
  return { ...base, streaming };
}

export function computeCost(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Record<string, ModelPricing>,
  cachedInputTokens?: number | null,
  cacheCreationTokens?: number | null,
): number | null {
  if (!model) return null;
  const rates = resolvePricing(model, pricing);
  if (!rates) return null;
  // Disjoint token buckets (no overlap): fresh input billed at full rate,
  // cache reads at the read rate, cache writes at the write rate (1.25x on
  // Anthropic). inputTokens is the FRESH (non-cached) count for every provider.
  const fresh = Math.max(0, inputTokens ?? 0);
  const read = cachedInputTokens ?? 0;
  const creation = cacheCreationTokens ?? 0;
  const readRate = rates.cacheInputPerMTok ?? rates.inputPerMTok;
  const writeRate = rates.cacheWritePerMTok ?? rates.inputPerMTok;
  return (
    (fresh / 1_000_000) * rates.inputPerMTok +
    (read / 1_000_000) * readRate +
    (creation / 1_000_000) * writeRate +
    ((outputTokens ?? 0) / 1_000_000) * rates.outputPerMTok
  );
}

function normalizeModelKey(model: string): string {
  const slash = model.lastIndexOf("/");
  const bare = slash === -1 ? model : model.slice(slash + 1);
  return bare.toLowerCase();
}

// Exact match first (preserves existing semantics); otherwise fall back to a
// normalized comparison that strips any `provider/` prefix and lowercases, so
// e.g. `deepseek/deepseek-chat` resolves to a `deepseek-chat` pricing entry.
function resolvePricing(
  model: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing | undefined {
  const exact = pricing[model];
  if (exact) return exact;
  const normalized = normalizeModelKey(model);
  for (const [key, rates] of Object.entries(pricing)) {
    if (normalizeModelKey(key) === normalized) return rates;
  }
  return undefined;
}
