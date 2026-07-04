import { readFileSync } from "node:fs";
import type { Config } from "../config/index.js";
import type { Store } from "../store/index.js";
import { computeCost, parseTrace, type TraceEvent } from "./parse.js";

export interface ParseSummary {
  total: number;
  parsed: number;
  failed: number;
}

export function runParse(
  store: Store,
  pricing: Config["pricing"],
  opts: { all: boolean },
): ParseSummary {
  const targets = store.requestsToParse(opts.all);
  let parsed = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const events = readTraceEvents(target.trace_file);
      const result = parseTrace(events);
      const cost = computeCost(
        result.model,
        result.inputTokens,
        result.outputTokens,
        pricing,
      );
      store.upsertMetrics({
        requestId: target.id,
        format: result.format,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        stopReason: result.stopReason,
        streaming: result.streaming ? 1 : 0,
        toolCallCount: result.toolCalls.length,
        cost,
        parsedAt: new Date().toISOString(),
      });
      store.replaceToolCalls(target.id, result.toolCalls);
      parsed++;
    } catch (err) {
      failed++;
      console.error(`parse: ${target.id} failed: ${(err as Error).message}`);
    }
  }

  return { total: targets.length, parsed, failed };
}

function readTraceEvents(file: string): TraceEvent[] {
  const content = readFileSync(file, "utf8");
  const events: TraceEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) events.push(JSON.parse(trimmed) as TraceEvent);
  }
  return events;
}
