// Claude optimization validation — non-inferiority analysis over captured sessions.
//
// Reads the aap store, groups sessions by meta.run (the config label you tag runs
// with), and reports per-config cost/quality distributions plus a bootstrap
// non-inferiority test between a baseline and an optimized config.
//
// Usage (run from repo root so node_modules resolves):
//   node benchmarks/validate.mjs --task iterative-fix-plus --agent claude \
//        --baseline baseline --optimized optimize
//
// Options:
//   --db <path>        sqlite path (default: ~/.aap/data/aap.sqlite)
//   --task <label>     filter by meta.task (default: iterative-fix-plus)
//   --agent <label>    filter by meta.agent (default: claude)
//   --baseline <run>   meta.run label for the baseline arm
//   --optimized <run>  meta.run label for the optimized arm
//   --margin <f>       non-inferiority margin on quality (default: 0.05 = 5pp)
//   --boot <n>         bootstrap resamples (default: 5000)
//
// With no --baseline/--optimized it just prints a per-config summary.

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DB = arg("db", join(homedir(), ".aap", "data", "aap.sqlite"));
const TASK = arg("task", "iterative-fix-plus");
const AGENT = arg("agent", "claude");
const BASE = arg("baseline", null);
const OPT = arg("optimized", null);
const MARGIN = parseFloat(arg("margin", "0.05"));
const BOOT = parseInt(arg("boot", "5000"), 10);

const db = new Database(DB, { readonly: true });

const rows = db
  .prepare(
    `SELECT s.id, s.meta,
       COALESCE(SUM(m.input_tokens),0)+COALESCE(SUM(m.cached_input_tokens),0) AS input_tokens,
       COALESCE(SUM(m.cached_input_tokens),0) AS cached,
       COALESCE(SUM(m.output_tokens),0) AS output,
       COALESCE(SUM(m.cost),0) AS cost,
       COUNT(r.id) AS requests
     FROM sessions s
     LEFT JOIN requests r ON r.session_id = s.id
     LEFT JOIN metrics  m ON m.request_id = r.id
     GROUP BY s.id`,
  )
  .all();

function ratio(s) {
  if (!s || !s.includes("/")) return null;
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : null;
}

// Parse + filter into per-session records grouped by config (meta.run).
const groups = new Map();
for (const r of rows) {
  let meta;
  try {
    meta = r.meta ? JSON.parse(r.meta) : {};
  } catch {
    continue;
  }
  if (meta.task !== TASK) continue;
  if (AGENT && meta.agent && meta.agent !== AGENT) continue;
  const cfg = meta.run || "(untagged)";
  const rec = {
    id: r.id,
    cost: r.cost,
    requests: r.requests,
    input: r.input_tokens,
    cacheHit: r.input_tokens ? r.cached / r.input_tokens : 0,
    success: meta.verify === "pass" ? 1 : meta.verify === "fail" ? 0 : null,
    fixture: ratio(meta.fixture),
    edge: ratio(meta.edge),
  };
  if (!groups.has(cfg)) groups.set(cfg, []);
  groups.get(cfg).push(rec);
}

const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const vals = (arr, k) =>
  arr.map((r) => r[k]).filter((v) => v != null && !Number.isNaN(v));

function fmtPct(x) {
  return Number.isNaN(x) ? "—" : `${(x * 100).toFixed(0)}%`;
}
function fmt$(x) {
  return Number.isNaN(x) ? "—" : `$${x.toFixed(4)}`;
}

console.log(`\nStore: ${DB}`);
console.log(`Filter: task=${TASK}${AGENT ? ` agent=${AGENT}` : ""}\n`);
console.log("Per-config summary (group by meta.run):");
console.log(
  "  config".padEnd(22),
  "n".padStart(3),
  "cost(mean)".padStart(12),
  "success".padStart(8),
  "fixture".padStart(8),
  "edge".padStart(6),
  "cacheHit".padStart(9),
);
const sortedCfgs = [...groups.keys()].sort();
for (const cfg of sortedCfgs) {
  const g = groups.get(cfg);
  console.log(
    `  ${cfg}`.padEnd(22),
    String(g.length).padStart(3),
    fmt$(mean(vals(g, "cost"))).padStart(12),
    fmtPct(mean(vals(g, "success"))).padStart(8),
    fmtPct(mean(vals(g, "fixture"))).padStart(8),
    fmtPct(mean(vals(g, "edge"))).padStart(6),
    fmtPct(mean(vals(g, "cacheHit"))).padStart(9),
  );
}

if (!BASE || !OPT) {
  console.log(
    `\nTip: add --baseline <run> --optimized <run> for the non-inferiority test.`,
  );
  console.log(`Available run labels: ${sortedCfgs.join(", ") || "(none)"}\n`);
  process.exit(0);
}

// An "arm" collects all sessions whose meta.run equals the label or starts with
// "<label>-" (so per-run tags like baseline-01..baseline-10 fold into one arm).
function collectArm(label) {
  const out = [];
  for (const [cfg, recs] of groups)
    if (cfg === label || cfg.startsWith(`${label}-`)) out.push(...recs);
  return out.length ? out : null;
}
const base = collectArm(BASE);
const opt = collectArm(OPT);
if (!base || !opt) {
  console.error(
    `\nMissing config: baseline="${BASE}" opt="${OPT}". Have: ${sortedCfgs.join(", ")}`,
  );
  process.exit(1);
}

// Bootstrap the difference of a per-group statistic (opt - base).
function bootDiff(aArr, bArr, stat, B = BOOT) {
  const diffs = [];
  const draw = (arr) => arr[(Math.random() * arr.length) | 0];
  for (let i = 0; i < B; i++) {
    const ra = Array.from({ length: aArr.length }, () => draw(aArr));
    const rb = Array.from({ length: bArr.length }, () => draw(bArr));
    diffs.push(stat(ra) - stat(rb));
  }
  diffs.sort((x, y) => x - y);
  return {
    lo: diffs[Math.floor(0.025 * B)],
    hi: diffs[Math.floor(0.975 * B)],
    mid: diffs[Math.floor(0.5 * B)],
  };
}

const meanCost = (g) => mean(vals(g, "cost"));
const meanSucc = (g) => mean(vals(g, "success"));
const meanEdge = (g) => mean(vals(g, "edge"));

const baseCost = meanCost(base),
  optCost = meanCost(opt);
const savings = (baseCost - optCost) / baseCost;
// Bootstrap savings% CI (opt cheaper => positive savings).
const savingsBoot = bootDiff(
  base,
  opt,
  (g) => -meanCost(g), // trick: diff(opt,base) of (-cost) = base - opt
);
const savingsLo = savingsBoot.lo / baseCost;
const savingsHi = savingsBoot.hi / baseCost;

const succDiff = bootDiff(opt, base, meanSucc); // opt - base
const edgeDiff = bootDiff(opt, base, meanEdge); // opt - base

console.log(`\n=== ${OPT} vs ${BASE} ===`);
console.log(`n: baseline=${base.length}, optimized=${opt.length}`);
if (base.length < 8 || opt.length < 8)
  console.log(`⚠  small N — CIs will be wide; aim for N≥10 per arm.`);

console.log(`\nCost:`);
console.log(
  `  baseline mean ${fmt$(baseCost)} | optimized mean ${fmt$(optCost)}`,
);
console.log(
  `  savings ${(savings * 100).toFixed(1)}%  (95% CI ${(savingsLo * 100).toFixed(1)}% … ${(savingsHi * 100).toFixed(1)}%)`,
);

function verdict(diff, margin) {
  // Non-inferior if lower CI bound of (opt - base) > -margin.
  return diff.lo > -margin
    ? `NON-INFERIOR (lower CI ${diff.lo.toFixed(3)} > -${margin})`
    : `NOT shown (lower CI ${diff.lo.toFixed(3)} ≤ -${margin})`;
}

console.log(`\nQuality (non-inferiority, margin ${MARGIN}):`);
console.log(
  `  success rate:  base ${fmtPct(meanSucc(base))} → opt ${fmtPct(meanSucc(opt))} | Δ 95% CI [${succDiff.lo.toFixed(3)}, ${succDiff.hi.toFixed(3)}] → ${verdict(succDiff, MARGIN)}`,
);
console.log(
  `  edge score:    base ${fmtPct(meanEdge(base))} → opt ${fmtPct(meanEdge(opt))} | Δ 95% CI [${edgeDiff.lo.toFixed(3)}, ${edgeDiff.hi.toFixed(3)}] → ${verdict(edgeDiff, MARGIN)}`,
);

const baseFails = vals(base, "success").filter((v) => v === 0).length;
const optFails = vals(opt, "success").filter((v) => v === 0).length;
console.log(
  `\nRegression guard: baseline failures ${baseFails}/${base.length}, optimized failures ${optFails}/${opt.length}`,
);
console.log(
  `\nHeadline: ${(savings * 100).toFixed(0)}% cheaper` +
    (succDiff.lo > -MARGIN && edgeDiff.lo > -MARGIN
      ? `, quality non-inferior within ${(MARGIN * 100).toFixed(0)}pp.`
      : `, quality parity NOT yet established — collect more runs.`),
);
console.log();
