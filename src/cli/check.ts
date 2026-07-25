import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { loadConfig } from "../config/index.js";
import { type SessionSummary, collectSummaries } from "./compare.js";
import { openStore } from "../store/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const budgetSchema = z.object({
  max_total_cost_usd: z.number().positive().default(20.0),
  max_per_task_cost_usd: z.number().positive().default(5.0),
});

const thresholdSchema = z.object({
  max_increase_pct: z.number().nonnegative().optional(),
  max_decrease_pp: z.number().nonnegative().optional(),
  cost_max_increase_pct: z.number().nonnegative().optional(),
  success_max_decrease_pp: z.number().nonnegative().optional(),
});

const regressionsSchema = z.object({
  metrics: z
    .object({
      default_margin: z.number().positive().default(0.05),
    })
    .partial()
    .default({}),
  thresholds: z.record(z.string(), thresholdSchema).default({}),
  budget: budgetSchema.partial().default({}),
});

type Regressions = z.infer<typeof regressionsSchema>;

function resolveRegressionsPath(): string | null {
  const envPath = process.env.AAP_REGRESSIONS;
  if (envPath) return envPath;

  const candidates = [
    join(process.cwd(), "benchmarks", "regressions.toml"),
    join(__dirname, "..", "..", "benchmarks", "regressions.toml"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function loadRegressions(): Regressions {
  const path = resolveRegressionsPath();
  if (!path) {
    console.error(
      "No regressions.toml found. Set AAP_REGRESSIONS or place it at benchmarks/regressions.toml",
    );
    process.exit(2);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(
      `Cannot read regressions file "${path}": ${(err as Error).message}`,
    );
    process.exit(2);
  }
  let data: unknown;
  try {
    data = parseToml(raw);
  } catch (err) {
    console.error(`Invalid TOML in "${path}": ${(err as Error).message}`);
    process.exit(2);
  }
  const parsed = regressionsSchema.safeParse(data);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`Invalid regressions config in "${path}":\n${msg}`);
    process.exit(2);
  }
  return parsed.data;
}

interface MetricResult {
  task: string;
  metric: string;
  baselineValue: number;
  currentValue: number;
  threshold: number;
  deltaPct: number;
  deltaAbs: number;
  violation: boolean;
  direction: "increase" | "decrease";
}

function definedTasks(
  sessions: SessionSummary[],
): Array<{ task: string; sessions: SessionSummary[] }> {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const t = s.meta?.task;
    if (!t) continue;
    const group = map.get(t) ?? [];
    group.push(s);
    map.set(t, group);
  }
  return [...map.entries()].map(([task, grouped]) => ({
    task,
    sessions: grouped,
  }));
}

function checkSessions(
  baseline: SessionSummary[],
  current: SessionSummary[],
  regs: Regressions,
  json: boolean,
): MetricResult[] {
  const results: MetricResult[] = [];
  const bByTask = definedTasks(baseline);
  const cByTask = definedTasks(current);
  const taskSet = new Map<string, SessionSummary[]>();
  for (const { task, sessions } of bByTask) taskSet.set(task, sessions);
  const cMap = new Map<string, SessionSummary[]>();
  for (const { task, sessions } of cByTask) cMap.set(task, sessions);
  const allTasks = [...new Set([...taskSet.keys(), ...cMap.keys()])].sort();

  const defaultThresholds = regs.thresholds[""] ?? {};

  for (const task of allTasks) {
    const bGroup = taskSet.get(task);
    const cGroup = cMap.get(task);
    if (!bGroup || bGroup.length === 0 || !cGroup || cGroup.length === 0)
      continue;

    const taskRegs = regs.thresholds[task] ?? {};
    const bSum = sumGroup(bGroup);
    const cSum = sumGroup(cGroup);
    const bSucc = meanSuccess(bGroup);
    const cSucc = meanSuccess(cGroup);
    const bCHR = meanCacheHitRate(bGroup);
    const cCHR = meanCacheHitRate(cGroup);

    addResult(results, task, "cost", bSum.cost, cSum.cost, {
      maxIncreasePct:
        taskRegs.cost_max_increase_pct ??
        defaultThresholds.cost_max_increase_pct ??
        defaultThresholds.max_increase_pct ??
        regs.thresholds.cost?.max_increase_pct ??
        10,
      direction: "increase",
    });

    addResult(results, task, "requests", bSum.requests, cSum.requests, {
      maxIncreasePct:
        taskRegs.max_increase_pct ??
        defaultThresholds.max_increase_pct ??
        regs.thresholds.requests?.max_increase_pct ??
        20,
      direction: "increase",
    });

    addResult(results, task, "success_rate", bSucc, cSucc, {
      maxDecreasePp:
        taskRegs.success_max_decrease_pp ??
        defaultThresholds.success_max_decrease_pp ??
        defaultThresholds.max_decrease_pp ??
        regs.thresholds.success_rate?.max_decrease_pp ??
        5,
      direction: "decrease",
    });

    addResult(results, task, "cache_hit_rate", bCHR, cCHR, {
      maxDecreasePp:
        taskRegs.max_decrease_pp ??
        defaultThresholds.max_decrease_pp ??
        regs.thresholds.cache_hit_rate?.max_decrease_pp ??
        10,
      direction: "decrease",
    });
  }

  results.sort(
    (a, b) => a.task.localeCompare(b.task) || a.metric.localeCompare(b.metric),
  );

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    renderResults(results, baseline, current);
  }

  return results;
}

interface AggSum {
  requests: number;
  cost: number;
  inputTokens: number;
  cachedInputTokens: number;
}

function sumGroup(group: SessionSummary[]): AggSum {
  return group.reduce(
    (a, s) => ({
      requests: a.requests + s.requests,
      cost: a.cost + s.cost,
      inputTokens: a.inputTokens + s.totalInputTokens,
      cachedInputTokens: a.cachedInputTokens + s.cachedInputTokens,
    }),
    { requests: 0, cost: 0, inputTokens: 0, cachedInputTokens: 0 },
  );
}

function meanSuccess(group: SessionSummary[]): number {
  const vals: number[] = [];
  for (const s of group) {
    if (s.meta?.verify === "pass") vals.push(1);
    else if (s.meta?.verify === "fail") vals.push(0);
  }
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function meanCacheHitRate(group: SessionSummary[]): number {
  const total = group.reduce((a, s) => a + s.totalInputTokens, 0);
  if (total === 0) return 0;
  return group.reduce((a, s) => a + s.cachedInputTokens, 0) / total;
}

function addResult(
  results: MetricResult[],
  task: string,
  metric: string,
  baselineValue: number,
  currentValue: number,
  opts: {
    maxIncreasePct?: number;
    maxDecreasePp?: number;
    direction: "increase" | "decrease";
  },
): void {
  const deltaAbs = currentValue - baselineValue;
  const deltaPct =
    baselineValue !== 0 ? (deltaAbs / Math.abs(baselineValue)) * 100 : 0;
  let violation = false;
  let threshold = 0;

  if (opts.direction === "increase" && opts.maxIncreasePct !== undefined) {
    threshold = opts.maxIncreasePct;
    violation = deltaPct > threshold;
  } else if (
    opts.direction === "decrease" &&
    opts.maxDecreasePp !== undefined
  ) {
    threshold = opts.maxDecreasePp;
    violation = baselineValue - currentValue > threshold / 100;
  }

  results.push({
    task,
    metric,
    baselineValue,
    currentValue,
    threshold,
    deltaPct,
    deltaAbs,
    violation,
    direction: opts.direction,
  });
}

function renderResults(
  results: MetricResult[],
  baseline: SessionSummary[],
  current: SessionSummary[],
): void {
  if (results.length === 0) {
    console.log(
      "No comparable task groups found between baseline and current runs.",
    );
    return;
  }

  const bRun = baseline[0]?.meta?.run ?? "baseline";
  const cRun = current[0]?.meta?.run ?? "current";

  console.log(`\nRegression check: ${cRun} vs ${bRun}`);
  console.log(
    `  baseline sessions: ${baseline.length}  current sessions: ${current.length}\n`,
  );

  const tasks = [...new Set(results.map((r) => r.task))];
  for (const task of tasks) {
    const taskResults = results.filter((r) => r.task === task);
    console.log(`  [${task}]`);
    for (const r of taskResults) {
      const icon = r.violation ? "\u2717" : "\u2713";
      const bFmt = fmtVal(r.metric, r.baselineValue);
      const cFmt = fmtVal(r.metric, r.currentValue);
      const delta =
        r.direction === "increase"
          ? `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%`
          : `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}pp`;
      const thr =
        r.direction === "increase"
          ? `max +${r.threshold.toFixed(0)}%`
          : `max \u2212${r.threshold.toFixed(0)}pp`;

      console.log(
        `    ${icon} ${r.metric.padEnd(16)} ${bFmt.padStart(10)} \u2192 ${cFmt.padStart(10)}  (${delta}, threshold: ${thr})${r.violation ? `  VIOLATION` : ""}`,
      );
    }
    console.log();
  }

  const violations = results.filter((r) => r.violation);
  if (violations.length > 0) {
    console.log(`  ${violations.length} violation(s) found.`);
    console.log();
  } else {
    console.log("  All metrics within thresholds.");
    console.log();
  }
}

function fmtVal(metric: string, val: number): string {
  if (metric === "cost") return `$${val.toFixed(4)}`;
  if (metric === "success_rate" || metric === "cache_hit_rate")
    return `${(val * 100).toFixed(0)}%`;
  if (metric === "requests") return Math.round(val).toString();
  return val.toFixed(1);
}

export function checkRegressions(args: string[]): void {
  const json = args.includes("--json");
  const baselineTag = argValue(args, "--baseline");
  const currentTag = argValue(args, "--current");

  if (!baselineTag || !currentTag) {
    console.error(
      "Usage: aap check --baseline <run-tag> --current <run-tag> [--json]",
    );
    process.exitCode = 2;
    return;
  }

  const regs = loadRegressions();
  const config = loadConfig();
  const store = openStore(config.storage.dir);

  try {
    const baselineIds = store.sessionIdsByMeta("run", baselineTag);
    const currentIds = store.sessionIdsByMeta("run", currentTag);

    if (baselineIds.length === 0) {
      console.error(`No sessions found for baseline run "${baselineTag}".`);
      process.exitCode = 2;
      return;
    }
    if (currentIds.length === 0) {
      console.error(`No sessions found for current run "${currentTag}".`);
      process.exitCode = 2;
      return;
    }

    const { summaries: bSum } = collectSummaries(store, baselineIds);
    const { summaries: cSum } = collectSummaries(store, currentIds);

    const results = checkSessions(bSum, cSum, regs, json);

    const hasViolations = results.some((r) => r.violation);
    if (hasViolations) {
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}
