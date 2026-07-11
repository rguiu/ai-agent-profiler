// Dry-run simulator: replays an existing session's data through the optimize
// layer to quantify what would have been saved without re-running the agent.

import { readFile } from "node:fs/promises";
import type { Store, ToolCall } from "../store/index.js";
import { computeCost } from "../parse/index.js";
import type { ModelPricing } from "../config/schema.js";
import {
  OptimizeLayer,
  type OptimizeConfig,
  type OptimizeAction,
} from "./layer.js";
import { turnCache } from "./cache-cost.js";

export interface CacheCostResult {
  hitTokens: number;
  missTokens: number;
  hitRate: number;
  inputCost: number | null;
}

export interface SimulationResult {
  sessionId: string;
  totalRequests: number;
  totalInputTokens: number;
  totalResultTokens: number;
  actions: OptimizeAction[];
  tokensSaved: number;
  savingsPercent: number;
  byType: Record<string, { count: number; tokensSaved: number }>;
  // Populated only when pricing is supplied. Models DeepSeek prefix-cache cost
  // for the raw session (baseline) vs. the optimize-layer-rewritten session.
  cache?: {
    baseline: CacheCostResult;
    optimized: CacheCostResult;
    inputCostDelta: number | null;
  };
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
  pricing?: Record<string, ModelPricing>,
): Promise<SimulationResult> {
  const detail = store.getSession(sessionId);
  if (!detail) throw new Error(`Session "${sessionId}" not found`);

  const layer = new OptimizeLayer(config);
  let totalResultTokens = 0;
  const turns: RequestTurn[] = [];

  // Replay each request in order
  for (const request of detail.requests) {
    const fullReq = store.getRequest(request.id);
    if (!fullReq || !fullReq.trace_file) continue;

    const events = await readTraceEvents(fullReq.trace_file);
    const turn = simulateRequest(layer, events, fullReq.toolCalls);
    if (turn) turns.push({ ...turn, model: fullReq.model });
    totalResultTokens += fullReq.toolCalls.reduce(
      (sum, tc) => sum + (tc.result_tokens ?? 0),
      0,
    );
  }

  const cache = pricing ? computeCacheCost(turns, pricing) : undefined;
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
    cache,
  };
}

interface SimTurn {
  baseline: string;
  optimized: string;
}

interface RequestTurn extends SimTurn {
  model: string | null;
}

function simulateRequest(
  layer: OptimizeLayer,
  events: TraceEvent[],
  toolCalls: ToolCall[],
): SimTurn | null {
  let turn: SimTurn | null = null;

  // Find request body — this is what we'd rewrite on the request path
  for (const event of events) {
    if (event.type === "request_body" && event.data) {
      const body = Buffer.from(event.data, "base64");
      const rewritten = layer.rewriteRequestBody(body);
      turn = {
        baseline: body.toString("utf8"),
        optimized: rewritten.toString("utf8"),
      };
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

  return turn;
}

// Model DeepSeek prefix-cache cost for the session, comparing the raw request
// bodies (baseline) against the optimize-layer-rewritten bodies (optimized).
// Each is scored independently: an optimization that edits the prompt prefix
// resets the shared prefix and shows up as a higher miss-token count / cost.
function computeCacheCost(
  turns: RequestTurn[],
  pricing: Record<string, ModelPricing>,
): {
  baseline: CacheCostResult;
  optimized: CacheCostResult;
  inputCostDelta: number | null;
} {
  const baseline = scoreStream(
    turns.map((t) => ({ prompt: t.baseline, model: t.model })),
    pricing,
  );
  const optimized = scoreStream(
    turns.map((t) => ({ prompt: t.optimized, model: t.model })),
    pricing,
  );
  const inputCostDelta =
    baseline.inputCost !== null && optimized.inputCost !== null
      ? optimized.inputCost - baseline.inputCost
      : null;
  return { baseline, optimized, inputCostDelta };
}

function scoreStream(
  stream: Array<{ prompt: string; model: string | null }>,
  pricing: Record<string, ModelPricing>,
): CacheCostResult {
  let prev: string | null = null;
  let hitTokens = 0;
  let missTokens = 0;
  let inputCost = 0;
  let priced = false;

  for (const { prompt, model } of stream) {
    const tc = turnCache(prev, prompt);
    hitTokens += tc.hitTokens;
    missTokens += tc.missTokens;
    // computeCost prices cached tokens at cacheInputPerMTok and the rest at
    // inputPerMTok. Output tokens are cache-independent, so we pass 0.
    const cost = computeCost(model, tc.promptTokens, 0, pricing, tc.hitTokens);
    if (cost !== null) {
      inputCost += cost;
      priced = true;
    }
    prev = prompt;
  }

  const promptTokens = hitTokens + missTokens;
  return {
    hitTokens,
    missTokens,
    hitRate: promptTokens > 0 ? hitTokens / promptTokens : 0,
    inputCost: priced ? inputCost : null,
  };
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
