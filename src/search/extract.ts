import { createHash } from "node:crypto";
import {
  decodeResponseBody,
  decodeResponseObjects,
  extractResultText,
  parseRequestJson,
  parseTrace,
  type TraceEvent,
} from "../parse/index.js";

export type ChunkKind =
  "prompt" | "response" | "tool_call" | "tool_result" | "error";

// Denormalized request/session metadata stamped onto every chunk so search
// results can be filtered and linked without joining back to aap.sqlite.
export interface ChunkSource {
  requestId: string;
  sessionId: string;
  ts: string | null;
  model: string | null;
  requestKind: string | null;
  repo: string | null;
  cwd: string | null;
  client: string | null;
}

export interface ChunkDraft {
  chunkUid: string;
  kind: ChunkKind;
  role: string | null;
  toolName: string | null;
  filePath: string | null;
  isError: boolean;
  contentHash: string;
  text: string;
}

interface Item {
  kind: ChunkKind;
  role: string | null;
  toolName: string | null;
  filePath: string | null;
  isError: boolean;
  text: string;
}

// Chunk sizing: bounded so a single huge tool result (e.g. a whole-file read)
// cannot bloat the index, split on line boundaries so snippets stay readable.
const MAX_CHUNK_CHARS = 4000;
const MAX_PARTS_PER_ITEM = 64;

const FILE_ARG_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "target_file",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function filePathFromArgs(args: unknown): string | null {
  let record: Record<string, unknown> | null;
  if (typeof args === "string") {
    if (args === "") return null;
    try {
      record = asRecord(JSON.parse(args));
    } catch {
      return null;
    }
  } else {
    record = asRecord(args);
  }
  if (!record) return null;
  for (const key of FILE_ARG_KEYS) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

// Split into line-aligned parts of at most MAX_CHUNK_CHARS. Deterministic for
// a given input, so content hashes (and dedup) are stable across re-indexing.
export function splitText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > MAX_CHUNK_CHARS) {
      if (current) {
        parts.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) {
        parts.push(line.slice(i, i + MAX_CHUNK_CHARS));
        if (parts.length >= MAX_PARTS_PER_ITEM) return parts;
      }
      continue;
    }
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (candidate.length > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = line;
      if (parts.length >= MAX_PARTS_PER_ITEM) return parts;
    } else {
      current = candidate;
    }
  }
  if (current && parts.length < MAX_PARTS_PER_ITEM) parts.push(current);
  return parts;
}

function contentHash(kind: string, toolName: string | null, text: string) {
  return createHash("sha256")
    .update(kind)
    .update("|")
    .update(toolName ?? "")
    .update("|")
    .update(text)
    .digest("hex")
    .slice(0, 32);
}

// Walk the request body messages. History repeats across requests in a
// session; the (session_id, content_hash) unique index deduplicates on insert.
function itemsFromRequestMessages(events: TraceEvent[]): Item[] {
  const record = parseRequestJson(events);
  if (!record) return [];
  const items: Item[] = [];
  const toolNameById = new Map<string, string>();

  const addToolCall = (id: string | null, name: string, args: unknown) => {
    if (id) toolNameById.set(id, name);
    const argsText =
      typeof args === "string" ? args : args ? JSON.stringify(args) : "";
    items.push({
      kind: "tool_call",
      role: "assistant",
      toolName: name,
      filePath: filePathFromArgs(args),
      isError: false,
      text: argsText ? `${name} ${argsText}` : name,
    });
  };

  const addToolResult = (
    id: string | null,
    content: unknown,
    isError: boolean,
  ) => {
    items.push({
      kind: "tool_result",
      role: "tool",
      toolName: id ? (toolNameById.get(id) ?? null) : null,
      filePath: null,
      isError,
      text: extractResultText(content),
    });
  };

  for (const message of asArray(record.messages)) {
    const msg = asRecord(message);
    if (!msg) continue;
    const role = asString(msg.role);
    if (role === "system" || role === "developer") continue;

    if (role === "tool") {
      addToolResult(asString(msg.tool_call_id), msg.content, false);
      continue;
    }

    // OpenAI-style assistant tool calls live outside content blocks.
    for (const call of asArray(msg.tool_calls)) {
      const callRecord = asRecord(call);
      const fn = callRecord ? asRecord(callRecord.function) : null;
      const name = fn ? asString(fn.name) : null;
      if (name) {
        addToolCall(
          callRecord ? asString(callRecord.id) : null,
          name,
          fn?.arguments ?? "",
        );
      }
    }

    const textKind: ChunkKind = role === "assistant" ? "response" : "prompt";
    const contentStr = asString(msg.content);
    if (contentStr !== null) {
      items.push({
        kind: textKind,
        role,
        toolName: null,
        filePath: null,
        isError: false,
        text: contentStr,
      });
      continue;
    }

    for (const block of asArray(msg.content)) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "text" || b.type === "thinking") {
        const text = asString(b.text) ?? asString(b.thinking) ?? "";
        items.push({
          kind: textKind,
          role,
          toolName: null,
          filePath: null,
          isError: false,
          text,
        });
      } else if (b.type === "tool_use") {
        const name = asString(b.name);
        if (name) addToolCall(asString(b.id), name, b.input);
      } else if (b.type === "tool_result") {
        addToolResult(asString(b.tool_use_id), b.content, b.is_error === true);
      } else {
        // Bedrock converse blocks: {toolUse: {...}} / {toolResult: {...}}
        const toolUse = asRecord(b.toolUse);
        if (toolUse) {
          const name = asString(toolUse.name);
          if (name)
            addToolCall(asString(toolUse.toolUseId), name, toolUse.input);
        }
        const toolResult = asRecord(b.toolResult);
        if (toolResult) {
          addToolResult(
            asString(toolResult.toolUseId) ?? asString(b.toolUseId),
            toolResult.content,
            asString(toolResult.status) === "error",
          );
        }
      }
    }
  }
  return items;
}

function anthropicResponseText(objects: unknown[]): string {
  let out = "";
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    if (record.type === "message" || record.type === "message_start") {
      const message =
        record.type === "message" ? record : asRecord(record.message);
      for (const block of asArray(message?.content)) {
        const b = asRecord(block);
        if (b?.type === "text") out += asString(b.text) ?? "";
        if (b?.type === "thinking") out += asString(b.thinking) ?? "";
      }
    } else if (record.type === "content_block_delta") {
      const delta = asRecord(record.delta);
      if (delta?.type === "text_delta") out += asString(delta.text) ?? "";
      if (delta?.type === "thinking_delta")
        out += asString(delta.thinking) ?? "";
    }
  }
  return out;
}

function openAIResponseText(objects: unknown[]): string {
  let out = "";
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    for (const choice of asArray(record.choices)) {
      const c = asRecord(choice);
      if (!c) continue;
      const container = asRecord(c.delta) ?? asRecord(c.message);
      if (!container) continue;
      out += asString(container.reasoning_content) ?? "";
      out += asString(container.content) ?? "";
    }
  }
  return out;
}

function bedrockResponseText(objects: unknown[]): string {
  let out = "";
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    const output = asRecord(record.output);
    const message = output ? asRecord(output.message) : null;
    for (const block of asArray(message?.content)) {
      const b = asRecord(block);
      if (b) out += asString(b.text) ?? "";
    }
    const blockDelta = asRecord(record.contentBlockDelta);
    const delta = blockDelta ? asRecord(blockDelta.delta) : null;
    if (delta) out += asString(delta.text) ?? "";
  }
  return out;
}

function ollamaResponseText(objects: unknown[]): string {
  let out = "";
  for (const object of objects) {
    const record = asRecord(object);
    if (!record) continue;
    const message = asRecord(record.message);
    if (message) out += asString(message.content) ?? "";
    out += asString(record.response) ?? "";
  }
  return out;
}

function itemsFromResponse(events: TraceEvent[]): Item[] {
  const items: Item[] = [];
  const parsed = parseTrace(events);
  const { objects } = decodeResponseObjects(events);

  let text = "";
  switch (parsed.format) {
    case "anthropic":
      text = anthropicResponseText(objects);
      break;
    case "openai":
      text = openAIResponseText(objects);
      break;
    case "bedrock":
      text = bedrockResponseText(objects);
      break;
    case "ollama":
      text = ollamaResponseText(objects);
      break;
    case "unknown":
      break;
  }
  if (text.trim()) {
    items.push({
      kind: "response",
      role: "assistant",
      toolName: null,
      filePath: null,
      isError: false,
      text,
    });
  }

  for (const call of parsed.toolCalls) {
    items.push({
      kind: "tool_call",
      role: "assistant",
      toolName: call.name,
      filePath: filePathFromArgs(call.arguments),
      isError: false,
      text: call.arguments ? `${call.name} ${call.arguments}` : call.name,
    });
  }
  return items;
}

function itemsFromErrors(events: TraceEvent[]): Item[] {
  const items: Item[] = [];
  for (const event of events) {
    if (event.type !== "error") continue;
    const record = event as Record<string, unknown>;
    const phase = asString(record.phase) ?? "unknown";
    const message = asString(record.message) ?? "";
    items.push({
      kind: "error",
      role: null,
      toolName: null,
      filePath: null,
      isError: true,
      text: `[${phase}] ${message}`,
    });
  }
  const decoded = decodeResponseBody(events);
  if (decoded && decoded.status !== null && decoded.status >= 400) {
    items.push({
      kind: "error",
      role: null,
      toolName: null,
      filePath: null,
      isError: true,
      text: `HTTP ${decoded.status}: ${decoded.text}`,
    });
  }
  return items;
}

// Pure: trace events + request metadata -> deduplicatable chunk drafts.
// Deterministic ordering gives every chunk a stable uid
// ({requestId}:{item}:{part}) so re-indexing a request is idempotent and a
// future embeddings table can reference chunks by uid.
export function extractChunks(
  events: TraceEvent[],
  source: ChunkSource,
): ChunkDraft[] {
  const items = [
    ...itemsFromRequestMessages(events),
    ...itemsFromResponse(events),
    ...itemsFromErrors(events),
  ];

  const drafts: ChunkDraft[] = [];
  items.forEach((item, itemIndex) => {
    if (!item.text.trim()) return;
    splitText(item.text).forEach((part, partIndex) => {
      if (!part.trim()) return;
      drafts.push({
        chunkUid: `${source.requestId}:${itemIndex}:${partIndex}`,
        kind: item.kind,
        role: item.role,
        toolName: item.toolName,
        filePath: item.filePath,
        isError: item.isError,
        contentHash: contentHash(item.kind, item.toolName, part),
        text: part,
      });
    });
  });
  return drafts;
}
