import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export interface TraceEvent {
  type: string;
  data?: string;
  headers?: Record<string, string | string[]>;
  status?: number;
  [key: string]: unknown;
}

export interface ParsedTrace {
  format: "anthropic" | "openai" | "unknown";
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  toolCalls: string[];
  streaming: boolean;
}

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

interface Extract {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  toolCalls: string[];
}

function emptyExtract(): Extract {
  return {
    model: null,
    inputTokens: null,
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
  }
  const stop = asString(message.stop_reason);
  if (stop) acc.stopReason = stop;
  for (const block of asArray(message.content)) {
    const record = asRecord(block);
    if (record?.type === "tool_use") {
      const name = asString(record.name);
      if (name) acc.toolCalls.push(name);
    }
  }
}

function parseAnthropic(objects: unknown[]): Extract {
  const acc = emptyExtract();
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
        const block = asRecord(record.content_block);
        if (block?.type === "tool_use") {
          const name = asString(block.name);
          if (name) acc.toolCalls.push(name);
        }
        break;
      }
    }
  }
  return acc;
}

function parseOpenAI(objects: unknown[]): Extract {
  const acc = emptyExtract();
  const toolsByIndex = new Map<number, string>();
  const toolsFallback: string[] = [];

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
        if (!name) continue;
        const index = asNumber(toolRecord.index);
        if (index !== null) {
          if (!toolsByIndex.has(index)) toolsByIndex.set(index, name);
        } else {
          toolsFallback.push(name);
        }
      }
    }
  }

  acc.toolCalls =
    toolsByIndex.size > 0
      ? [...toolsByIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, name]) => name)
      : toolsFallback;
  return acc;
}

export function parseTrace(events: TraceEvent[]): ParsedTrace {
  const empty: ParsedTrace = {
    format: "unknown",
    model: null,
    inputTokens: null,
    outputTokens: null,
    stopReason: null,
    toolCalls: [],
    streaming: false,
  };

  const responseEvent = events.find((e) => e.type === "response");
  const chunks = events
    .filter((e) => e.type === "response_body" && typeof e.data === "string")
    .map((e) => Buffer.from(e.data as string, "base64"));
  if (chunks.length === 0) return empty;

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
  if (objects.length === 0) return { ...empty, streaming };

  if (looksAnthropic(objects)) {
    return { ...parseAnthropic(objects), format: "anthropic", streaming };
  }
  if (looksOpenAI(objects)) {
    return { ...parseOpenAI(objects), format: "openai", streaming };
  }
  return { ...empty, streaming };
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
