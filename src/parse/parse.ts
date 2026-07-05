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

export interface ParsedContext {
  messageCount: number;
  systemTokens: number;
  toolsDefined: number;
  toolsTokens: number;
}

export interface ParsedTrace {
  format: "anthropic" | "openai" | "unknown";
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
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
}

interface Extract {
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  toolCalls: ParsedToolCall[];
}

function emptyExtract(): Extract {
  return {
    model: null,
    inputTokens: null,
    cachedInputTokens: null,
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
      const input = asNumber(usage.prompt_tokens);
      if (input !== null) acc.inputTokens = input;
      const output = asNumber(usage.completion_tokens);
      if (output !== null) acc.outputTokens = output;
      const cached = openAICachedTokens(usage);
      if (cached !== null) acc.cachedInputTokens = cached;
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  let systemText = extractResultText(record.system ?? "");
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
      if (blockRecord?.type === "tool_result") {
        add(asString(blockRecord.tool_use_id), blockRecord.content);
      }
    }
  }

  const tools = asArray(record.tools);
  const context: ParsedContext = {
    messageCount: messages.length,
    systemTokens: estimateTokens(systemText),
    toolsDefined: tools.length,
    toolsTokens: tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0,
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

export function parseTrace(events: TraceEvent[]): ParsedTrace {
  const { toolResults, context } = parseRequestBody(events);
  const base: ParsedTrace = {
    format: "unknown",
    model: null,
    inputTokens: null,
    cachedInputTokens: null,
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
  const streaming =
    contentType.includes("text/event-stream") ||
    text.startsWith("data:") ||
    text.startsWith("event:");
  const objects = streaming ? extractSSE(text) : parseWholeJson(text);
  if (objects.length === 0) return { ...base, streaming };

  if (looksAnthropic(objects)) {
    return {
      ...parseAnthropic(objects),
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
  return { ...base, streaming };
}

export function computeCost(
  model: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Record<string, ModelPricing>,
): number | null {
  if (!model) return null;
  const rates = pricing[model];
  if (!rates) return null;
  return (
    ((inputTokens ?? 0) / 1_000_000) * rates.inputPerMTok +
    ((outputTokens ?? 0) / 1_000_000) * rates.outputPerMTok
  );
}
