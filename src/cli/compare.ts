import { loadConfig } from "../config/index.js";
import { recommend } from "../recommend/index.js";
import { openStore, type SessionDetail, type Store } from "../store/index.js";

export interface SessionSummary {
  id: string;
  client: string | null;
  meta: Record<string, string> | null;
  requests: number;
  inputTokens: number;
  totalInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
  toolCalls: number;
  distinctTools: number;
  resultTokens: number;
  toolsTokens: number;
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

// OpenAI-compatible providers (incl. DeepSeek) report prompt_tokens as the FULL
// input, cached tokens included. Anthropic/Bedrock report input_tokens as the
// uncached remainder, with cache reads counted separately. Normalise both to a
// single convention: inputTokens = true uncached, totalInputTokens = uncached +
// cached — so the comparison table never double-counts the cached portion.
function cachedIsInInput(format: string | null): boolean {
  return format === "openai";
}

export function summarize(detail: SessionDetail): SessionSummary {
  const requests = detail.requests;
  let uncached = 0;
  let cached = 0;
  for (const r of requests) {
    const raw = r.input_tokens ?? 0;
    const cachedTok = r.cached_input_tokens ?? 0;
    cached += cachedTok;
    uncached += cachedIsInInput(r.format) ? Math.max(0, raw - cachedTok) : raw;
  }
  return {
    id: detail.session.id,
    client: detail.session.client,
    meta: detail.session.meta ?? null,
    requests: requests.length,
    inputTokens: uncached,
    totalInputTokens: uncached + cached,
    cachedInputTokens: cached,
    outputTokens: requests.reduce((a, r) => a + (r.output_tokens ?? 0), 0),
    cost: requests.reduce((a, r) => a + (r.cost ?? 0), 0),
    toolCalls: requests.reduce((a, r) => a + (r.tool_call_count ?? 0), 0),
    distinctTools: detail.analysis.toolUsage.length,
    resultTokens: detail.analysis.toolUsage.reduce(
      (a, t) => a + t.result_tokens,
      0,
    ),
    toolsTokens: detail.analysis.context.tools_tokens_total,
    wallMs: wallMs(detail),
    recommendations: recommend(detail).length,
  };
}

function columnLabel(s: SessionSummary): string {
  const parts: string[] = [];
  const run = s.meta?.run;
  const task = s.meta?.task;
  if (run) parts.push(run);
  if (task) parts.push(task);
  if (parts.length > 0) return parts.join("/");
  return s.id.slice(0, 12);
}

function delta(a: number, b: number): string {
  if (a === 0) return "";
  const pct = ((b - a) / a) * 100;
  if (Math.abs(pct) < 0.5) return "=";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

function pad(s: string, w: number, right = false): string {
  if (right) return s.padStart(w);
  return s.padEnd(w);
}

type MetricRow = [
  string,
  (s: SessionSummary) => number,
  (s: SessionSummary) => string,
];

function cacheRate(s: SessionSummary): string {
  const total = s.totalInputTokens;
  if (total === 0) return "—";
  const pct = (s.cachedInputTokens / total) * 100;
  return `${pct.toFixed(0)}%`;
}

function totalInput(s: SessionSummary): number {
  return s.totalInputTokens;
}

const METRICS: MetricRow[] = [
  ["Requests", (s) => s.requests, (s) => num(s.requests)],
  ["Total input", totalInput, (s) => num(totalInput(s))],
  ["  ↳ cached", (s) => s.cachedInputTokens, (s) => num(s.cachedInputTokens)],
  ["  ↳ uncached", (s) => s.inputTokens, (s) => num(s.inputTokens)],
  [
    "Cache hit rate",
    (s) => s.cachedInputTokens / Math.max(1, totalInput(s)),
    cacheRate,
  ],
  ["Output tokens", (s) => s.outputTokens, (s) => num(s.outputTokens)],
  ["Cost", (s) => s.cost, (s) => (s.cost ? `$${s.cost.toFixed(4)}` : "$0")],
  ["Tool calls", (s) => s.toolCalls, (s) => num(s.toolCalls)],
  ["Distinct tools", (s) => s.distinctTools, (s) => num(s.distinctTools)],
  ["Result tokens", (s) => s.resultTokens, (s) => `~${num(s.resultTokens)}`],
  ["Tool-def resent", (s) => s.toolsTokens, (s) => `~${num(s.toolsTokens)}`],
  ["Wall time", (s) => s.wallMs, (s) => `${(s.wallMs / 1000).toFixed(1)}s`],
];

function renderTable(
  title: string,
  colNames: string[],
  rows: Array<{ label: string; cells: string[]; delta?: string }>,
): string {
  const labelW = Math.max(14, ...rows.map((r) => r.label.length));
  const colW = colNames.map((name, i) =>
    Math.max(name.length, ...rows.map((r) => (r.cells[i] ?? "").length)),
  );
  const deltaW = Math.max(5, ...rows.map((r) => (r.delta ?? "").length));

  const lines: string[] = [];
  lines.push(`  ${title}`);

  // Header
  const header =
    "  " +
    pad("", labelW) +
    "  " +
    colNames.map((n, i) => pad(n, colW[i] ?? n.length, true)).join("  ") +
    (rows.some((r) => r.delta) ? "  " + pad("Δ", deltaW, true) : "");
  lines.push(header);
  lines.push("  " + "─".repeat(header.length - 2));

  for (const row of rows) {
    let line =
      "  " +
      pad(row.label, labelW) +
      "  " +
      row.cells.map((c, i) => pad(c, colW[i] ?? c.length, true)).join("  ");
    if (row.delta) line += "  " + pad(row.delta, deltaW, true);
    lines.push(line);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderComparison(summaries: SessionSummary[]): string {
  const runs = [
    ...new Set(summaries.map((s) => s.meta?.run).filter(Boolean)),
  ] as string[];
  const tasks = [
    ...new Set(summaries.map((s) => s.meta?.task).filter(Boolean)),
  ] as string[];

  if (runs.length === 2 && tasks.length > 1) {
    return renderGroupedComparison(summaries, runs, tasks);
  }

  const colNames = summaries.map(columnLabel);
  const rows = METRICS.map(([label, getNum, getFmt]) => ({
    label,
    cells: summaries.map(getFmt),
    delta:
      summaries.length === 2
        ? delta(getNum(summaries[0]!), getNum(summaries[1]!))
        : undefined,
  }));

  // Append fixture / edge test-result rows when tagged by the benchmark harness.
  const hasFixture = summaries.some((s) => s.meta?.fixture);
  const hasEdge = summaries.some((s) => s.meta?.edge);
  if (hasFixture) {
    rows.push({
      label: "Fixture tests",
      cells: summaries.map((s) => s.meta?.fixture ?? "—"),
      delta: undefined,
    });
  }
  if (hasEdge) {
    rows.push({
      label: "Edge tests",
      cells: summaries.map((s) => s.meta?.edge ?? "—"),
      delta: undefined,
    });
  }

  return "\n" + renderTable("Session comparison", colNames, rows);
}

function renderGroupedComparison(
  summaries: SessionSummary[],
  runs: string[],
  tasks: string[],
): string {
  const sections: string[] = [];
  sections.push("");
  sections.push(`  ╭─ ${runs[0]} vs ${runs[1]} ─╮`);
  sections.push("");

  for (const task of tasks) {
    const cols = runs.map((r) =>
      summaries.find((s) => s.meta?.task === task && s.meta?.run === r),
    );
    if (cols.every((c) => !c)) continue;

    const rows = METRICS.map(([label, getNum, getFmt]) => ({
      label,
      cells: cols.map((c) => (c ? getFmt(c) : "—")),
      delta: cols[0] && cols[1] ? delta(getNum(cols[0]), getNum(cols[1])) : "",
    }));

    // Append fixture / edge test-result rows per task.
    const hasFixture = cols.some((c) => c?.meta?.fixture);
    const hasEdge = cols.some((c) => c?.meta?.edge);
    if (hasFixture) {
      rows.push({
        label: "Fixture tests",
        cells: cols.map((c) => c?.meta?.fixture ?? "—"),
        delta: "",
      });
    }
    if (hasEdge) {
      rows.push({
        label: "Edge tests",
        cells: cols.map((c) => c?.meta?.edge ?? "—"),
        delta: "",
      });
    }

    sections.push(renderTable(`[${task}]`, runs, rows));
  }

  // Totals
  const totals = runs.map((r) => {
    const group = summaries.filter((s) => s.meta?.run === r);
    return {
      requests: group.reduce((a, s) => a + s.requests, 0),
      inputTokens: group.reduce((a, s) => a + s.inputTokens, 0),
      totalInputTokens: group.reduce((a, s) => a + s.totalInputTokens, 0),
      cachedInputTokens: group.reduce((a, s) => a + s.cachedInputTokens, 0),
      outputTokens: group.reduce((a, s) => a + s.outputTokens, 0),
      cost: group.reduce((a, s) => a + s.cost, 0),
      toolCalls: group.reduce((a, s) => a + s.toolCalls, 0),
      wallMs: group.reduce((a, s) => a + s.wallMs, 0),
    };
  });

  const t0 = totals[0]!;
  const t1 = totals[1]!;
  const totalCacheRate = (t: typeof t0) => {
    const total = t.totalInputTokens;
    return total > 0
      ? `${((t.cachedInputTokens / total) * 100).toFixed(0)}%`
      : "—";
  };
  const totalRows = [
    {
      label: "Requests",
      cells: totals.map((t) => num(t.requests)),
      delta: delta(t0.requests, t1.requests),
    },
    {
      label: "Total input",
      cells: totals.map((t) => num(t.totalInputTokens)),
      delta: delta(t0.totalInputTokens, t1.totalInputTokens),
    },
    {
      label: "  ↳ cached",
      cells: totals.map((t) => num(t.cachedInputTokens)),
      delta: delta(t0.cachedInputTokens, t1.cachedInputTokens),
    },
    {
      label: "  ↳ uncached",
      cells: totals.map((t) => num(t.inputTokens)),
      delta: delta(t0.inputTokens, t1.inputTokens),
    },
    { label: "Cache hit rate", cells: totals.map(totalCacheRate), delta: "" },
    {
      label: "Output tokens",
      cells: totals.map((t) => num(t.outputTokens)),
      delta: delta(t0.outputTokens, t1.outputTokens),
    },
    {
      label: "Cost",
      cells: totals.map((t) => `$${t.cost.toFixed(4)}`),
      delta: delta(t0.cost, t1.cost),
    },
    {
      label: "Tool calls",
      cells: totals.map((t) => num(t.toolCalls)),
      delta: delta(t0.toolCalls, t1.toolCalls),
    },
    {
      label: "Wall time",
      cells: totals.map((t) => `${(t.wallMs / 1000).toFixed(1)}s`),
      delta: delta(t0.wallMs, t1.wallMs),
    },
  ];
  sections.push(renderTable("TOTAL", runs, totalRows));

  return sections.join("\n");
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
  const runs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--task") {
      task = args[i + 1];
      i++;
      continue;
    }
    if (arg === "--run") {
      const v = args[i + 1];
      if (v) runs.push(v);
      i++;
      continue;
    }
    if (!arg.startsWith("--")) ids.push(arg);
  }

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    if (task) ids.push(...store.sessionIdsByMeta("task", task));
    if (runs.length > 0) {
      const runIds = new Set(
        runs.flatMap((r) => store.sessionIdsByMeta("run", r)),
      );
      if (ids.length > 0) {
        ids.splice(0, ids.length, ...ids.filter((id) => runIds.has(id)));
      } else {
        ids.push(...runIds);
      }
    }
    if (ids.length === 0) {
      console.error(
        "Usage: aap compare <session-id> [...] | --task <name> [--run <tag> ...] [--json]",
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
