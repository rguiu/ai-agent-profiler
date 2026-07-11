// Ad-hoc harness: model a growing agent conversation over a bundled fixture and
// score DeepSeek prefix-cache cost with vs. without the OptimizeLayer, and with
// the cache-safe profile. No API calls — uses the shipped OptimizeLayer +
// cache-cost model + real fixture file contents.
//
// Usage: tsx benchmarks/cache-fixture-demo.ts [fixture] [editCycles]
//   fixture     directory under benchmarks/fixtures (default simple-cache-test)
//   editCycles  number of edit→re-read→re-run iterations (default 3)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { OptimizeLayer, CACHE_SAFE_OVERRIDES } from "../src/optimize/layer.js";
import { turnCache } from "../src/optimize/cache-cost.js";
import { computeCost } from "../src/parse/parse.js";

const FIXTURE = process.argv[2] ?? "simple-cache-test";
const EDIT_CYCLES = Number(process.argv[3] ?? 3);

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures", FIXTURE);
const read = (p: string) => readFileSync(join(fx, p), "utf8");

const MODEL = "deepseek-v4-pro";
const pricing = {
  "deepseek-v4-pro": {
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheInputPerMTok: 0.0036,
  },
};

const SYSTEM =
  "You are opencode, an interactive CLI coding agent. Follow the user's " +
  "instructions carefully. Use the provided tools to read and edit files. " +
  "Be concise and precise. ".repeat(20);

const tools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string" },
          new: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by pattern",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
    },
  },
];

type Msg = Record<string, unknown>;
type Step = { tool: string; args: Record<string, string>; result: string };

function listFiles(sub: string): string[] {
  const dir = join(fx, sub);
  try {
    return readdirSync(dir)
      .filter((f) => statSync(join(dir, f)).isFile())
      .map((f) => join(sub, f));
  } catch {
    return [];
  }
}

const srcFiles = listFiles("src");
const testFiles = listFiles("test");

function testOutput(pass: boolean): string {
  // A realistic node --test TAP block, sized to the number of test files.
  const per = testFiles.length || 1;
  const lines: string[] = ["> node --test test/*.test.js", ""];
  for (let i = 1; i <= per * 4; i++) {
    lines.push(`${pass || i % 5 !== 0 ? "ok" : "not ok"} ${i} - case ${i}`);
  }
  lines.push(
    `# tests ${per * 4}`,
    `# pass ${pass ? per * 4 : per * 4 - per}`,
    `# fail ${pass ? 0 : per}`,
  );
  return lines.join("\n");
}

// Build a realistic iterative-fix trajectory: explore, run tests, then repeated
// edit → re-read → re-run cycles (the shape iterative-fix-plus actually induces).
function buildSteps(): Step[] {
  const steps: Step[] = [];
  const glob = [...srcFiles, ...testFiles]
    .map((f) => relative(fx, join(fx, f)))
    .join("\n");
  steps.push({ tool: "glob", args: { pattern: "**/*.js" }, result: glob });
  try {
    steps.push({
      tool: "read",
      args: { path: "README.md" },
      result: read("README.md"),
    });
  } catch {
    /* no README */
  }
  for (const f of [...srcFiles, ...testFiles]) {
    steps.push({ tool: "read", args: { path: f }, result: read(f) });
  }
  steps.push({
    tool: "bash",
    args: { command: "node --test test/*.test.js" },
    result: testOutput(false),
  });

  for (let c = 0; c < EDIT_CYCLES; c++) {
    const target = srcFiles[c % Math.max(srcFiles.length, 1)] ?? "src/index.js";
    const content = read(target);
    steps.push({
      tool: "edit",
      args: { path: target, old: `cycle-${c}-old`, new: `cycle-${c}-new` },
      result: `Edited ${target}`,
    });
    steps.push({ tool: "read", args: { path: target }, result: content });
    steps.push({
      tool: "grep",
      args: { pattern: "not implemented" },
      result: srcFiles
        .map((f) => `${f}:1: throw new Error('not implemented')`)
        .join("\n"),
    });
    const last = c === EDIT_CYCLES - 1;
    steps.push({
      tool: "bash",
      args: { command: "node --test test/*.test.js" },
      result: testOutput(last),
    });
  }
  return steps;
}

const steps = buildSteps();

function buildBody(messages: Msg[]): Buffer {
  return Buffer.from(
    JSON.stringify({ model: MODEL, system: SYSTEM, tools, messages }),
  );
}

function scoreStream(bodies: string[]): {
  hit: number;
  miss: number;
  cost: number;
} {
  let prev: string | null = null;
  let hit = 0,
    miss = 0,
    cost = 0;
  for (const body of bodies) {
    const tc = turnCache(prev, body);
    hit += tc.hitTokens;
    miss += tc.missTokens;
    cost += computeCost(MODEL, tc.promptTokens, 0, pricing, tc.hitTokens) ?? 0;
    prev = body;
  }
  return { hit, miss, cost };
}

function run(layer: OptimizeLayer | null): {
  hit: number;
  miss: number;
  cost: number;
} {
  const messages: Msg[] = [
    {
      role: "user",
      content:
        "Fix all failing tests and implement the stubbed methods; run tests after each change.",
    },
  ];
  const bodies: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const callId = `call_${i}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: { name: step.tool, arguments: JSON.stringify(step.args) },
        },
      ],
    });
    // The live proxy only sees the FULL result in the request history and
    // reshapes the whole body via rewriteRequestBody each turn — it never
    // calls rewriteToolResult. Mirror that here.
    messages.push({ role: "tool", tool_call_id: callId, content: step.result });

    const raw = buildBody(messages);
    const sent = layer ? layer.rewriteRequestBody(raw) : raw;
    bodies.push(sent.toString("utf8"));
  }

  return scoreStream(bodies);
}

const base = run(null);
const opt = run(new OptimizeLayer());
const safe = run(new OptimizeLayer(CACHE_SAFE_OVERRIDES));

const fmt = (n: number) => Math.round(n).toLocaleString();
const usd = (n: number) => `$${n.toFixed(5)}`;
const rate = (s: { hit: number; miss: number }) =>
  `${Math.round((s.hit / (s.hit + s.miss)) * 100)}%`;

console.log(
  `\n${FIXTURE} — DeepSeek prefix-cache cost (input side, ${steps.length} requests, ${srcFiles.length} src + ${testFiles.length} test files)`,
);
console.log("─".repeat(78));
console.log(
  `                     hit-rate     hit tok      miss tok     input cost`,
);
const row = (label: string, s: { hit: number; miss: number; cost: number }) =>
  console.log(
    `  ${label.padEnd(17)} ${rate(s).padStart(6)}    ${fmt(s.hit).padStart(9)}    ${fmt(s.miss).padStart(9)}     ${usd(s.cost)}`,
  );
row("baseline", base);
row("optimize(default)", opt);
row("optimize(safe)", safe);
console.log("─".repeat(78));
const pctVs = (s: { cost: number }) =>
  `${s.cost > base.cost ? "+" : ""}${((s.cost / base.cost - 1) * 100).toFixed(1)}%`;
console.log(
  `  vs baseline:  default ${pctVs(opt)}   cache-safe ${pctVs(safe)}`,
);
console.log();
