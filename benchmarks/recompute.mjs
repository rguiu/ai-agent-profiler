// Read-only: re-parse every captured request with the CURRENT (fixed) parser and
// cost model, and diff against the cost stored at capture time. Surfaces
// cache-write (cache_creation) tokens — the fingerprint of the accounting bug.
//
// Does NOT modify the store. Run from the repo root after `npm run build`:
//   node benchmarks/recompute.mjs
//
// The fix is cost-neutral for OpenAI/DeepSeek (no cache_creation), so those
// sessions show ~0 change. Anthropic/Bedrock sessions (with cache writes) are
// where the old numbers were wrong — point AAP_DB at a store that has them.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTrace, computeCost } from "../dist/parse/index.js";
import { loadConfig } from "../dist/config/index.js";

const DB = process.env.AAP_DB || join(homedir(), ".aap", "data", "aap.sqlite");

let pricing = {};
try {
  pricing = loadConfig().pricing ?? {};
} catch (e) {
  console.error("config load failed:", e.message);
}

function readEvents(file) {
  try {
    const content = readFileSync(file, "utf8");
    const ev = [];
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (t) ev.push(JSON.parse(t));
    }
    return ev;
  } catch {
    return null;
  }
}

const db = new Database(DB, { readonly: true });
const rows = db
  .prepare(
    `SELECT r.id, r.trace_file, s.meta, m.cost AS old_cost, m.model AS old_model
     FROM requests r
     JOIN sessions s ON s.id = r.session_id
     LEFT JOIN metrics m ON m.request_id = r.id
     WHERE r.trace_file IS NOT NULL`,
  )
  .all();

const groups = new Map();
for (const r of rows) {
  let meta = {};
  try {
    meta = r.meta ? JSON.parse(r.meta) : {};
  } catch {
    /* ignore */
  }
  const key = `${meta.agent ?? "?"}/${meta.task ?? "?"}/${meta.run ?? "(none)"}`;
  const events = readEvents(r.trace_file);
  let newCost = null;
  let creation = 0;
  if (events) {
    const p = parseTrace(events);
    creation = p.cacheCreationTokens ?? 0;
    newCost = computeCost(
      p.model ?? r.old_model,
      p.inputTokens,
      p.outputTokens,
      pricing,
      p.cachedInputTokens,
      p.cacheCreationTokens,
    );
  }
  const g = groups.get(key) ?? {
    n: 0,
    old: 0,
    new: 0,
    creation: 0,
    missing: 0,
    priced: 0,
  };
  g.n++;
  g.old += r.old_cost ?? 0;
  g.creation += creation;
  if (newCost == null) g.missing++;
  else {
    g.new += newCost;
    g.priced++;
  }
  groups.set(key, g);
}

console.log(`\nDB: ${DB}`);
console.log(`pricing models: ${Object.keys(pricing).join(", ") || "(none)"}\n`);
console.log(
  "config".padEnd(46),
  "n".padStart(4),
  "old $".padStart(10),
  "new $".padStart(10),
  "Δ%".padStart(8),
  "cacheWrite".padStart(12),
);
let tOld = 0,
  tNew = 0,
  tCre = 0,
  tMiss = 0;
for (const [k, g] of [...groups].sort()) {
  const d = g.old ? ((g.new - g.old) / g.old) * 100 : 0;
  console.log(
    k.slice(0, 46).padEnd(46),
    String(g.n).padStart(4),
    g.old.toFixed(4).padStart(10),
    g.new.toFixed(4).padStart(10),
    `${d >= 0 ? "+" : ""}${d.toFixed(1)}`.padStart(8),
    String(g.creation).padStart(12),
  );
  tOld += g.old;
  tNew += g.new;
  tCre += g.creation;
  tMiss += g.missing;
}
const dAll = tOld ? ((tNew - tOld) / tOld) * 100 : 0;
console.log(
  "\nTOTAL".padEnd(46),
  String(rows.length).padStart(4),
  tOld.toFixed(4).padStart(10),
  tNew.toFixed(4).padStart(10),
  `${dAll >= 0 ? "+" : ""}${dAll.toFixed(1)}`.padStart(8),
  String(tCre).padStart(12),
);
console.log(
  `\ncache-write tokens found: ${tCre} ${tCre === 0 ? "(→ this fix changes nothing here; any Δ is pricing-config drift, not the bug)" : "(→ these were unpriced before the fix)"}`,
);
if (tMiss) console.log(`requests that could not be re-parsed: ${tMiss}`);
console.log();
