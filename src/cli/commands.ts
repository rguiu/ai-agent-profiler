import { loadConfig } from "../config/index.js";
import { openStore } from "../store/index.js";

const MULTIPLEXERS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "git",
  "cargo",
  "go",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "docker",
  "make",
]);

export interface CommandStat {
  command: string;
  count: number;
  resultTokens: number;
}

interface BashCall {
  arguments: string | null;
  result_tokens: number | null;
}

// Reduce a shell command string to a comparable "program" key, e.g.
//   "grep -rn foo src"      -> "grep"
//   "npm test"              -> "npm test"
//   "cat a | grep b"        -> "cat"
//   "FOO=1 /usr/bin/rg x"   -> "rg"
export function classifyCommand(command: string): string {
  const withoutEnv = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  const firstSegment =
    withoutEnv.split(/\s*(?:\||&&|;|\|\|)\s*/)[0] ?? withoutEnv;
  const parts = firstSegment.trim().split(/\s+/).filter(Boolean);
  const prog = parts[0] ?? "";
  const base = prog.split("/").pop() ?? prog;
  const sub = parts[1];
  if (MULTIPLEXERS.has(base) && sub && !sub.startsWith("-")) {
    return `${base} ${sub}`;
  }
  return base || "(empty)";
}

function extractCommand(argsJson: string | null): string | null {
  if (!argsJson) return null;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  } catch {
    /* arguments were not valid JSON */
  }
  return null;
}

export function commandBreakdown(calls: BashCall[]): CommandStat[] {
  const stats = new Map<string, CommandStat>();
  for (const call of calls) {
    const command = extractCommand(call.arguments);
    if (!command) continue;
    const key = classifyCommand(command);
    const entry = stats.get(key) ?? { command: key, count: 0, resultTokens: 0 };
    entry.count += 1;
    entry.resultTokens += call.result_tokens ?? 0;
    stats.set(key, entry);
  }
  return [...stats.values()].sort(
    (a, b) => b.resultTokens - a.resultTokens || b.count - a.count,
  );
}

function num(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function commands(args: string[]): void {
  const json = args.includes("--json");
  const sessionIdx = args.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    const rows = commandBreakdown(store.bashToolCalls(sessionId));
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No shell commands captured (run `aap parse` first).");
      return;
    }
    console.log("COMMAND".padEnd(24) + "CALLS".padEnd(8) + "RESULT TOKENS");
    for (const r of rows) {
      console.log(
        r.command.padEnd(24) +
          String(r.count).padEnd(8) +
          `~${num(r.resultTokens)}`,
      );
    }
  } finally {
    store.close();
  }
}
