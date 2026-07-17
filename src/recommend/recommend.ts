import type { SessionDetail, GrowthPoint } from "../store/index.js";
import type { SearchReadChain } from "../analyze/index.js";

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
// Prefix-cache reconciliation: a request whose real cache-miss tokens exceed
// the content it newly added (miss − input growth) by this many tokens
// indicates a genuine prefix reset, not just the freshly-appended turn.
const PREFIX_RESET_ABS_MIN = 5000;
// A request that ran this long is almost certainly a stalled stream: the client
// (e.g. Claude Code) typically aborts around 5 min, so latencies pinned near
// that ceiling read as timeouts even though the proxy logs a 200.
const SLOW_REQUEST_MS = 120_000;
const STALLED_REQUEST_MS = 240_000;

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

export function recommend(
  detail: SessionDetail,
  searchReadChains?: SearchReadChain[],
): Recommendation[] {
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

  reportSlowRequests(detail, recs);

  reconcilePrefixCache(analysis.growth, recs);

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

  if (searchReadChains && searchReadChains.length > 0) {
    const exampleChains = searchReadChains.slice(0, 3);
    const detailLines = exampleChains.map(
      (c) =>
        `"${c.searchCommand}" → ${c.readTool} "${c.readFile}" (${c.stepsBetween} step${c.stepsBetween !== 1 ? "s" : ""} later)`,
    );
    const total = searchReadChains.length;
    recs.push({
      kind: "ordered_search_read_chain",
      severity: total >= 5 ? "high" : total >= 3 ? "warn" : "info",
      title: `${total} ordered search→read chain${total !== 1 ? "s" : ""} detected`,
      detail: `The agent ran search commands and subsequently read files within the searched directories. Examples: ${detailLines.join("; ")}${total > 3 ? ` (+${total - 3} more)` : ""}. These are confirmed locate→read patterns where a combined tool would eliminate at least ${total} round-trips.`,
    });
  }

  return recs;
}

// Surface requests whose latency indicates a stalled stream. The proxy logs
// these as 200s (bytes did flow), so they are otherwise invisible — but a
// request idling for minutes is what the user experiences as a "timeout" when
// the client finally aborts. Common on large tool-use responses (file writes).
function reportSlowRequests(
  detail: SessionDetail,
  recs: Recommendation[],
): void {
  const slow = detail.requests.filter(
    (r) => (r.latency_ms ?? 0) >= SLOW_REQUEST_MS,
  );
  if (slow.length === 0) return;

  const worst = Math.max(...slow.map((r) => r.latency_ms ?? 0));
  const stalled = slow.filter(
    (r) => (r.latency_ms ?? 0) >= STALLED_REQUEST_MS,
  ).length;
  const secs = (ms: number): string => (ms / 1000).toFixed(0);

  recs.push({
    kind: "slow_request",
    severity: stalled > 0 ? "high" : "warn",
    title: `${slow.length} request(s) took over ${secs(SLOW_REQUEST_MS)}s (slowest ~${secs(worst)}s)`,
    detail: `${slow.length} request(s) ran unusually long${
      stalled > 0
        ? `, ${stalled} of them past ${secs(STALLED_REQUEST_MS)}s — near the point where the client aborts, which surfaces as a timeout`
        : ""
    }. The response bytes may have arrived quickly with the connection then idling: a stalled stream that never closed. Large tool-use responses (e.g. file writes) are the usual trigger.`,
  });
}

// Reconcile the live prefix probe against ground truth: DeepSeek reports real
// cache-miss tokens per request. Miss tokens are only a problem when they EXCEED
// what the newly-added content explains: in a healthy append-only session the
// input grows by ~the appended turn and that same amount legitimately misses.
// A real prefix reset shows up as `miss − inputGrowth ≫ 0` — the provider
// recomputed a span that was NOT new. This is the signal the byte-level probe
// cannot give (it can't see the provider's response).
function reconcilePrefixCache(
  growth: GrowthPoint[],
  recs: Recommendation[],
): void {
  const points = growth
    .map((g) => ({
      inp: g.input_tokens ?? 0,
      cached: g.cached_input_tokens ?? 0,
    }))
    .filter((p) => p.inp > 0);

  // Need enough turns to establish a baseline and skip the cold-start turn.
  if (points.length < 5) return;

  const excesses: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const miss = Math.max(0, points[i]!.inp - points[i]!.cached);
    const growthTok = Math.max(0, points[i]!.inp - points[i - 1]!.inp);
    // Tokens that missed cache but were NOT newly added this turn.
    excesses.push(miss - growthTok);
  }

  const spikes = excesses.filter((e) => e >= PREFIX_RESET_ABS_MIN);
  if (spikes.length === 0) return;

  const worst = Math.max(...spikes);
  recs.push({
    kind: "prefix_cache_reset",
    severity: spikes.length >= 3 ? "high" : "warn",
    title: `${spikes.length} request(s) reset the prompt cache (~${n(worst)} tokens re-billed beyond new content)`,
    detail: `${spikes.length} request(s) missed cache on ~${n(worst)} tokens more than the content added that turn — a prefix edit forced DeepSeek to recompute an already-sent span. Check for mid-history mutations (a re-summarised block, reordered/edited tool defs, or a volatile early field like a timestamp).`,
  });
}
