import { readFile } from "node:fs/promises";
import type { Config } from "../config/index.js";
import type { Store } from "../store/index.js";
import {
  computeCost,
  extractResponseText,
  parseTrace,
  type ParsedToolResult,
  type TraceEvent,
} from "./parse.js";

export interface ParseSummary {
  total: number;
  parsed: number;
  failed: number;
}

export async function runParse(
  store: Store,
  pricing: Config["pricing"],
  opts: { all: boolean },
): Promise<ParseSummary> {
  const targets = store.requestsToParse(opts.all);
  const toolResults: ParsedToolResult[] = [];
  let parsed = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const events = await readTraceEvents(target.trace_file);
      const result = parseTrace(events);
      const cost = computeCost(
        result.model,
        result.inputTokens,
        result.outputTokens,
        pricing,
        result.cachedInputTokens,
        result.cacheCreationTokens,
      );
      store.upsertMetrics({
        requestId: target.id,
        format: result.format,
        model: result.model,
        inputTokens: result.inputTokens,
        cachedInputTokens: result.cachedInputTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        outputTokens: result.outputTokens,
        stopReason: result.stopReason,
        streaming: result.streaming ? 1 : 0,
        toolCallCount: result.toolCalls.length,
        cost,
        parsedAt: new Date().toISOString(),
        messageCount: result.context.messageCount,
        systemTokens: result.context.systemTokens,
        toolsDefined: result.context.toolsDefined,
        toolsTokens: result.context.toolsTokens,
        kind: result.context.kind,
      });
      store.replaceToolCalls(target.id, result.toolCalls);
      for (const toolResult of result.toolResults) toolResults.push(toolResult);

      if (target.session_id && result.context.kind === "title") {
        const responseText = extractResponseText(events);
        if (responseText)
          store.updateSessionTitle(target.session_id, responseText);
      } else if (target.session_id && result.context.kind === "recap") {
        const responseText = extractResponseText(events);
        if (responseText)
          store.updateSessionSummary(target.session_id, responseText);
      }

      parsed++;
    } catch (err) {
      failed++;
      console.error(`parse: ${target.id} failed: ${(err as Error).message}`);
    }
  }

  // Correlate tool results (from request bodies) back to the tool calls that
  // produced them, matched by tool id. Done after all calls are (re)written so
  // it is order-independent within a run.
  for (const toolResult of toolResults) {
    store.recordToolResult(toolResult.id, toolResult.bytes, toolResult.tokens);
  }

  return { total: targets.length, parsed, failed };
}

export async function readTraceEvents(file: string): Promise<TraceEvent[]> {
  const content = await readFile(file, "utf8");
  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) events.push(JSON.parse(trimmed) as TraceEvent);
  }
  return events;
}
