import type { SessionDetail } from "../store/index.js";

export interface Recommendation {
  kind: string;
  severity: "info" | "warn" | "high";
  title: string;
  detail: string;
}

const REPEATED_MIN = 3;
const AMPLIFICATION_MIN = 3000;
const TOOLS_OVERHEAD_MIN = 2000;
const CACHE_HIT_MIN = 0.5;
const SEARCH_COMMANDS_MIN = 3;
const GROWTH_MIN = 10000;
const GROWTH_FACTOR = 3;

function isReadLike(name: string): boolean {
  return /read|cat|view|open/i.test(name);
}

function pathFromArgs(args: string | null): string | null {
  if (!args) return null;
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    for (const key of ["file_path", "filePath", "path", "filename", "file"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  } catch {
    /* arguments were not valid JSON */
  }
  return null;
}

function n(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function recommend(detail: SessionDetail): Recommendation[] {
  const recs: Recommendation[] = [];
  const { analysis } = detail;

  for (const call of analysis.repeated) {
    if (call.count < REPEATED_MIN) continue;
    const path = pathFromArgs(call.arguments);
    if (isReadLike(call.name) && path) {
      recs.push({
        kind: "repeated_file_read",
        severity: call.count >= 5 ? "high" : "warn",
        title: `"${path}" was read ${call.count}× in this session`,
        detail: `The ${call.name} tool re-read the same file ${call.count} times. Reusing the earlier read (or caching it) would remove redundant context.`,
      });
    } else {
      recs.push({
        kind: "repeated_tool_call",
        severity: call.count >= 5 ? "high" : "warn",
        title: `${call.name} ran ${call.count}× with identical arguments`,
        detail: `The same call repeated ${call.count} times${
          call.arguments ? `: ${call.arguments}` : ""
        }. This is likely redundant work.`,
      });
    }
  }

  for (const tool of analysis.toolUsage) {
    if (tool.result_tokens >= AMPLIFICATION_MIN) {
      recs.push({
        kind: "high_amplification",
        severity: tool.result_tokens >= AMPLIFICATION_MIN * 3 ? "high" : "warn",
        title: `${tool.name} results added ~${n(tool.result_tokens)} tokens to context`,
        detail: `Across ${tool.count} call(s), ${tool.name} produced ~${n(
          tool.result_tokens,
        )} tokens that entered later prompts. Trimming or summarising this tool's output would reduce downstream cost.`,
      });
    }
  }

  const ctx = analysis.context;
  if (ctx.requests >= 3 && ctx.tools_tokens_total >= TOOLS_OVERHEAD_MIN) {
    const perRequest = Math.round(ctx.tools_tokens_total / ctx.requests);
    const totalInput = ctx.input_tokens_total + ctx.cached_input_tokens_total;
    const cacheRatio =
      totalInput > 0 ? ctx.cached_input_tokens_total / totalInput : 0;
    const big = ctx.tools_tokens_total >= TOOLS_OVERHEAD_MIN * 3;
    if (cacheRatio >= CACHE_HIT_MIN) {
      recs.push({
        kind: "context_duplication",
        severity: "info",
        title: `Tool definitions re-sent on every request (~${n(ctx.tools_tokens_total)} tokens total), but ${Math.round(cacheRatio * 100)}% of input was served from cache`,
        detail: `~${n(perRequest)} tokens of tool definitions were sent on each of ${ctx.requests} requests, yet ~${Math.round(cacheRatio * 100)}% of input tokens hit the provider's prompt cache — so this static payload is cheap. Keep the tool/system prefix byte-stable to preserve cache hits.`,
      });
    } else {
      recs.push({
        kind: "context_duplication",
        severity: big ? "high" : "warn",
        title: `Tool definitions re-sent on every request (~${n(ctx.tools_tokens_total)} tokens total)`,
        detail: `~${n(perRequest)} tokens of tool definitions were sent on each of ${ctx.requests} requests — a static payload duplicated across the whole session${totalInput > 0 ? `, with only ~${Math.round(cacheRatio * 100)}% of input served from cache` : ""}. Ensure the tool/system prefix is byte-stable (so prompt caching can apply) and trim unused tools.`,
      });
    }
  }

  const inputs = analysis.growth
    .map((g) => (g.input_tokens ?? 0) + (g.cached_input_tokens ?? 0))
    .filter((value) => value > 0);
  const first = inputs[0];
  const last = inputs.at(-1);
  if (
    first !== undefined &&
    last !== undefined &&
    last >= GROWTH_MIN &&
    last >= first * GROWTH_FACTOR
  ) {
    recs.push({
      kind: "context_growth",
      severity: "info",
      title: `Context grew from ~${n(first)} to ~${n(last)} tokens`,
      detail: `Input tokens grew ${(last / Math.max(first, 1)).toFixed(
        1,
      )}× over ${inputs.length} requests. Compaction or pruning could cut later prompt sizes.`,
    });
  }

  const searchCommands = analysis.commands.filter(
    (c) => c.category === "search",
  );
  const searchCalls = searchCommands.reduce((sum, c) => sum + c.count, 0);
  const reads = analysis.toolUsage
    .filter((t) => isReadLike(t.name))
    .reduce((sum, t) => sum + t.count, 0);
  if (searchCalls >= SEARCH_COMMANDS_MIN && reads > 0) {
    const names = searchCommands
      .map((c) => c.command)
      .slice(0, 4)
      .join(", ");
    recs.push({
      kind: "inefficient_search",
      severity: searchCalls >= SEARCH_COMMANDS_MIN * 2 ? "warn" : "info",
      title: `${searchCalls} locate-type shell command(s) alongside ${reads} file read(s)`,
      detail: `The agent ran ${searchCalls} search/list command(s) (${names}) through the shell and separately read files ${reads} time(s). A repo-aware locate-and-read tool that resolves a filename and returns its content in one call would remove these search→read round-trips.`,
    });
  }

  return recs;
}
