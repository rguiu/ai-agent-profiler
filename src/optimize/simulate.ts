// Dry-run simulator: replays an existing session's data through the optimize
// layer to quantify what would have been saved without re-running the agent.

import { readFile } from "node:fs/promises";
import type { Store, ToolCall } from "../store/index.js";
import {
  OptimizeLayer,
  type OptimizeConfig,
  type OptimizeAction,
} from "./layer.js";

export interface SimulationResult {
  sessionId: string;
  totalRequests: number;
  totalInputTokens: number;
  totalResultTokens: number;
  actions: OptimizeAction[];
  tokensSaved: number;
  savingsPercent: number;
  byType: Record<string, { count: number; tokensSaved: number }>;
}

interface TraceEvent {
  type: string;
  data?: string;
  [key: string]: unknown;
}

export async function simulateOptimize(
  store: Store,
  sessionId: string,
  config?: Partial<OptimizeConfig>,
): Promise<SimulationResult> {
  const detail = store.getSession(sessionId);
  if (!detail) throw new Error(`Session "${sessionId}" not found`);

  const layer = new OptimizeLayer(config);
  let totalResultTokens = 0;

  // Replay each request in order
  for (const request of detail.requests) {
    const fullReq = store.getRequest(request.id);
    if (!fullReq || !fullReq.trace_file) continue;

    const events = await readTraceEvents(fullReq.trace_file);
    simulateRequest(layer, events, fullReq.toolCalls);
    totalResultTokens += fullReq.toolCalls.reduce(
      (sum, tc) => sum + (tc.result_tokens ?? 0),
      0,
    );
  }

  const actions = layer.getActions();
  const tokensSaved = layer.getTotalTokensSaved();
  const totalInputTokens = detail.requests.reduce(
    (sum, r) => sum + (r.input_tokens ?? 0),
    0,
  );

  const byType: Record<string, { count: number; tokensSaved: number }> = {};
  for (const action of actions) {
    const entry = byType[action.type] ?? { count: 0, tokensSaved: 0 };
    entry.count++;
    entry.tokensSaved += action.tokensSaved;
    byType[action.type] = entry;
  }

  const denominator = totalResultTokens || totalInputTokens || 1;
  return {
    sessionId,
    totalRequests: detail.requests.length,
    totalInputTokens,
    totalResultTokens,
    actions,
    tokensSaved,
    savingsPercent: Math.round((tokensSaved / denominator) * 100),
    byType,
  };
}

function simulateRequest(
  layer: OptimizeLayer,
  events: TraceEvent[],
  toolCalls: ToolCall[],
): void {
  // Find request body — this is what we'd rewrite on the request path
  for (const event of events) {
    if (event.type === "request_body" && event.data) {
      const body = Buffer.from(event.data, "base64");
      layer.rewriteRequestBody(body);
      break;
    }
  }

  // Simulate tool result rewriting for each tool call in the response
  for (const tc of toolCalls) {
    if (!tc.result_tokens || tc.result_tokens < 10) continue;
    // We don't have the actual result content in the store (only token estimates),
    // so we simulate with the arguments as the cache key and a synthetic content
    // whose size matches the recorded tokens.
    const args = tc.arguments ?? "";
    const syntheticContent = "x".repeat((tc.result_tokens ?? 0) * 4);
    layer.rewriteToolResult(tc.name, args, syntheticContent);
  }
}

async function readTraceEvents(file: string): Promise<TraceEvent[]> {
  try {
    const content = await readFile(file, "utf8");
    const events: TraceEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) events.push(JSON.parse(trimmed) as TraceEvent);
    }
    return events;
  } catch {
    return [];
  }
}
