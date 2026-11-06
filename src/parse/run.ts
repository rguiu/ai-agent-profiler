import { readFile } from "node:fs/promises";
import type { Config } from "../config/index.js";
import { detectRepo } from "../session/index.js";
import { PARSE_MAX_ATTEMPTS, type Store } from "../store/index.js";
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
  // Sessions whose location is already known (or just recovered), so a tick
  // doesn't re-run git for every request in a session.
  const located = new Set<string>();
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

      // A session that reached the proxy without a launcher has no cwd/repo.
      // The system prompt carries the working directory, so recover it here —
      // off the hot path — and the session becomes indistinguishable from one
      // registered by `aap run`.
      if (target.session_id && !located.has(target.session_id)) {
        backfillLocation(store, target.session_id, result.context.cwd);
        if (store.getSessionRow(target.session_id)?.cwd) {
          located.add(target.session_id);
        }
      }

      parsed++;
      store.clearParseFailure(target.id);
    } catch (err) {
      failed++;
      const message = (err as Error).message;
      const attempts = store.markParseFailure(target.id, message);
      const terminal = !opts.all && attempts >= PARSE_MAX_ATTEMPTS;
      console.error(
        `parse: ${target.id} failed (attempt ${attempts})${terminal ? " — giving up" : ""}: ${message}`,
      );
    }
  }

  // Correlate tool results (from request bodies) back to the tool calls that
  // produced them, matched by tool id. Done after all calls are (re)written so
  // it is order-independent within a run.
  for (const toolResult of toolResults) {
    store.recordToolResult(
      toolResult.id,
      toolResult.bytes,
      toolResult.tokens,
      toolResult.error,
    );
  }

  return { total: targets.length, parsed, failed };
}

/** Record cwd/repo for a session that arrived without one. No-op when the
 * request didn't advertise a working directory (control-plane/title calls, or a
 * provider whose system prompt has no `<env>` block). */
function backfillLocation(
  store: Store,
  sessionId: string,
  cwd: string | null,
): void {
  if (!cwd) return;
  const row = store.getSessionRow(sessionId);
  if (!row || row.cwd) return;
  store.backfillSessionLocation(sessionId, cwd, detectRepo(cwd));
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
