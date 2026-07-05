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
  category: string;
  count: number;
  resultTokens: number;
}

export interface BashCall {
  arguments: string | null;
  result_tokens: number | null;
}

const CATEGORIES: Record<string, string> = {
  grep: "search",
  rg: "search",
  find: "search",
  fd: "search",
  ag: "search",
  ack: "search",
  locate: "search",
  ls: "search",
  tree: "search",
  cat: "read",
  head: "read",
  tail: "read",
  less: "read",
  more: "read",
  bat: "read",
  git: "vcs",
  npm: "build",
  npx: "build",
  pnpm: "build",
  yarn: "build",
  bun: "build",
  cargo: "build",
  go: "build",
  make: "build",
  node: "build",
  deno: "build",
  python: "build",
  python3: "build",
  pip: "build",
  docker: "build",
  cd: "nav",
  pwd: "nav",
  pushd: "nav",
  popd: "nav",
  sed: "edit",
  awk: "edit",
  tee: "edit",
};

// Map a classified command key (e.g. "git status" or "grep") to a coarse
// purpose category, so we can see *what kind* of work the shell is doing.
export function categorize(command: string): string {
  const base = command.split(/\s+/)[0] ?? "";
  return CATEGORIES[base] ?? "other";
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
    const entry = stats.get(key) ?? {
      command: key,
      category: categorize(key),
      count: 0,
      resultTokens: 0,
    };
    entry.count += 1;
    entry.resultTokens += call.result_tokens ?? 0;
    stats.set(key, entry);
  }
  return [...stats.values()].sort(
    (a, b) => b.resultTokens - a.resultTokens || b.count - a.count,
  );
}
