import { loadConfig } from "../config/index.js";
import { recommend } from "../recommend/index.js";
import { openStore, type SessionDetail, type Store } from "../store/index.js";

export interface SessionSummary {
  id: string;
  client: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  toolCalls: number;
  distinctTools: number;
  resultTokens: number;
  wallMs: number;
  recommendations: number;
}

function num(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function wallMs(detail: SessionDetail): number {
  const starts = detail.requests
    .map((r) => (r.started_at ? Date.parse(r.started_at) : NaN))
    .filter((t) => !Number.isNaN(t));
  const ends = detail.requests
    .map((r) => (r.ended_at ? Date.parse(r.ended_at) : NaN))
    .filter((t) => !Number.isNaN(t));
  if (starts.length === 0 || ends.length === 0) return 0;
  return Math.max(...ends) - Math.min(...starts);
}

export function summarize(detail: SessionDetail): SessionSummary {
  const requests = detail.requests;
  return {
    id: detail.session.id,
    client: detail.session.client,
    requests: requests.length,
    inputTokens: requests.reduce((a, r) => a + (r.input_tokens ?? 0), 0),
    outputTokens: requests.reduce((a, r) => a + (r.output_tokens ?? 0), 0),
    cost: requests.reduce((a, r) => a + (r.cost ?? 0), 0),
    toolCalls: requests.reduce((a, r) => a + (r.tool_call_count ?? 0), 0),
    distinctTools: detail.analysis.toolUsage.length,
    resultTokens: detail.analysis.toolUsage.reduce(
      (a, t) => a + t.result_tokens,
      0,
    ),
    wallMs: wallMs(detail),
    recommendations: recommend(detail).length,
  };
}

export function renderComparison(summaries: SessionSummary[]): string {
  const head = ["Metric", ...summaries.map((s) => s.id.slice(0, 8))];
  const rows: Array<[string, (s: SessionSummary) => string]> = [
    ["Client", (s) => s.client ?? "—"],
    ["Requests", (s) => num(s.requests)],
    ["Input tokens", (s) => num(s.inputTokens)],
    ["Output tokens", (s) => num(s.outputTokens)],
    ["Est. cost", (s) => (s.cost ? `$${s.cost.toFixed(4)}` : "$0")],
    ["Tool calls", (s) => num(s.toolCalls)],
    ["Distinct tools", (s) => num(s.distinctTools)],
    ["Tool result tokens", (s) => `~${num(s.resultTokens)}`],
    ["Wall time", (s) => `${(s.wallMs / 1000).toFixed(1)}s`],
    ["Recommendations", (s) => num(s.recommendations)],
  ];

  const lines: string[] = [];
  lines.push("# Session comparison", "");
  lines.push(`| ${head.join(" | ")} |`);
  lines.push(
    `| ${head.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
  );
  for (const [label, get] of rows) {
    lines.push(`| ${label} | ${summaries.map(get).join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function collectSummaries(
  store: Store,
  ids: string[],
): { summaries: SessionSummary[]; missing: string[] } {
  const summaries: SessionSummary[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const detail = store.getSession(id);
    if (!detail) missing.push(id);
    else summaries.push(summarize(detail));
  }
  return { summaries, missing };
}

export function compareSessions(args: string[]): void {
  const json = args.includes("--json");
  const ids: string[] = [];
  let task: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--task") {
      task = args[i + 1];
      i++;
      continue;
    }
    if (!arg.startsWith("--")) ids.push(arg);
  }

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    if (task) ids.push(...store.sessionIdsByMeta("task", task));
    if (ids.length === 0) {
      console.error(
        "Usage: aap compare <session-id> [<session-id> ...] | --task <name> [--json]",
      );
      process.exitCode = 1;
      return;
    }
    const { summaries, missing } = collectSummaries(store, ids);
    for (const id of missing) console.error(`Session "${id}" not found`);
    if (summaries.length === 0) {
      process.exitCode = 1;
      return;
    }
    if (json) {
      console.log(JSON.stringify(summaries, null, 2));
    } else {
      console.log(renderComparison(summaries));
    }
  } finally {
    store.close();
  }
}
