#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

type FilterFn = (input: string, args: string[]) => string;

interface FilterEntry {
  description: string;
  filter?: FilterFn;
}

type Registry = Record<string, Record<string, FilterEntry>>;

function gitStatus(input: string): string {
  const lines = input.split("\n");
  const branch = lines.find((l) => l.startsWith("##"));
  const stat = lines.filter((l) => l && !l.startsWith("##"));
  const result: string[] = [];
  if (branch) result.push(branch);
  if (stat.length > 0) {
    result.push(...stat.slice(0, 40));
  } else if (!branch) {
    return input.trimEnd();
  }
  return result.join("\n");
}

function gitDiff(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  const MAX_HUNK_LINES = 100;
  for (const line of lines) {
    result.push(line);
    if (result.length >= MAX_HUNK_LINES) {
      result.push("... (truncated)");
      break;
    }
  }
  return result.join("\n");
}

function gitShow(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  let inDiff = false;
  let diffLineCount = 0;
  const MAX_DIFF = 50;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      inDiff = true;
      diffLineCount = 0;
    }
    if (inDiff) {
      diffLineCount++;
      if (diffLineCount > MAX_DIFF) continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

function grepFilter(input: string): string {
  const lines = input.split("\n").filter((l) => l.trim());
  const MAX_LINES = 40;
  const deduped = dedupByFile(lines);
  return deduped.slice(0, MAX_LINES).join("\n");
}

function dedupByFile(lines: string[]): string[] {
  const seen = new Map<string, number>();
  const result: string[] = [];
  for (const line of lines) {
    const file = line.split(":")[0] ?? "";
    const count = seen.get(file) ?? 0;
    if (count < 5) {
      result.push(line);
      seen.set(file, count + 1);
    }
  }
  return result;
}

function lsFilter(input: string): string {
  const lines = input.split("\n");
  const MAX = 40;
  if (lines.length <= MAX + 1) return input.trimEnd();
  const header = lines[0];
  const items = lines.slice(1);
  return [header, ...items.slice(0, MAX)].join("\n");
}

function findFilter(input: string): string {
  return input
    .split("\n")
    .filter(
      (l) =>
        !l.includes("Permission denied") &&
        !l.includes("Operation not permitted"),
    )
    .slice(0, 60)
    .join("\n");
}

function catFilter(input: string): string {
  const lines = input.split("\n");
  const MAX = 60;
  if (lines.length <= MAX) return input.trimEnd();
  return [...lines.slice(0, MAX), "... (truncated)"].join("\n");
}

function nodeTestFilter(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  let tests = 0;
  let fail = 0;
  let inDiagnostic = false;

  for (const line of lines) {
    const mOk = line.match(/^ *ok (\d+)/);
    const mNotOk = line.match(/^ *not ok (\d+)/);

    if (mOk) {
      tests++;
      inDiagnostic = false;
      continue;
    }
    if (mNotOk) {
      tests++;
      fail++;
      result.push(line);
      inDiagnostic = true;
      continue;
    }

    if (
      inDiagnostic &&
      (line.startsWith("  ---") || line.startsWith("  ..."))
    ) {
      result.push(line);
      continue;
    }
    if (inDiagnostic && line.startsWith("  ")) {
      result.push(line);
      continue;
    }

    if (/^ *(# fail|# cancelled|# timeout)/.test(line)) {
      result.push(line);
      continue;
    }

    if (
      /^ *(# pass|# tests|# suites|# duration|# skipped|# todo|TAP version|^\d+\.\.\d+)/.test(
        line,
      )
    ) {
      continue;
    }

    result.push(line);
    inDiagnostic = false;
  }

  const summary =
    fail > 0
      ? `  ${tests - fail}/${tests} passed, ${fail} failed`
      : `  ${tests}/${tests} passed`;
  result.push(summary);
  return result.join("\n");
}

function npmFilter(input: string, args: string[]): string {
  const lines = input.split("\n");
  const hasError = lines.some((l) => /(error|fail|FAIL|ERROR|✗|✘|×)/i.test(l));
  if (!hasError) return `ok npm ${args.join(" ")}`;

  const errors = lines.filter((l) => /(error|fail|FAIL|ERROR|✗|✘|×)/i.test(l));
  const tail = lines.slice(-10);
  return [...errors.slice(0, 20), "---", ...tail].join("\n");
}

function cargoTestFilter(input: string): string {
  return input
    .split("\n")
    .filter(
      (l) =>
        /^(test |running |failures|error\[|\s{3}-->)/.test(l) ||
        l.startsWith("failures:"),
    )
    .slice(0, 60)
    .join("\n");
}

function cargoBuildFilter(input: string): string {
  const lines = input.split("\n");
  const keep = lines.filter(
    (l) =>
      /^(error|warning)\[/.test(l) ||
      /^(error|warning):/.test(l) ||
      l.startsWith("   -->"),
  );
  if (keep.length > 0) return keep.slice(0, 30).join("\n");
  if (lines.some((l) => l.includes("error"))) {
    return lines
      .filter((l) => l.includes("error"))
      .slice(0, 20)
      .join("\n");
  }
  return "ok cargo build";
}

export { type FilterFn, type FilterEntry, type Registry };

export const REGISTRY: Registry = {
  git: {
    status: {
      description: "Keep branch + modified/untracked files (max 40)",
      filter: gitStatus,
    },
    diff: { description: "Keep diff hunks (max 100 lines)", filter: gitDiff },
    log: {
      description: "Passthrough — already semantic (--oneline --decorate -15)",
    },
    show: {
      description: "Keep commit info + diff stat, limit diff hunks to 50 lines",
      filter: gitShow,
    },
  },
  grep: {
    "": {
      description: "Dedup by file, max 5 matches/file, max 40 lines total",
      filter: grepFilter,
    },
  },
  ls: {
    "": {
      description: "Keep directory header, limit to 40 entries",
      filter: lsFilter,
    },
  },
  find: {
    "": {
      description: "Strip permission errors, limit to 60 results",
      filter: findFilter,
    },
  },
  cat: {
    "": { description: "Limit to 60 lines", filter: catFilter },
  },
  node: {
    test: {
      description: "Parse TAP: keep failures + diagnostics, summary line",
      filter: nodeTestFilter,
    },
  },
  npm: {
    test: {
      description: "Show ok on success, errors on failure",
      filter: npmFilter,
    },
    run: {
      description: "Filter test/build/lint/typecheck via npmFilter",
      filter: npmFilter,
    },
  },
  cargo: {
    test: {
      description: "Keep test results + failures, drop compilation noise",
      filter: cargoTestFilter,
    },
    build: {
      description: "Keep error/warning lines only",
      filter: cargoBuildFilter,
    },
    check: {
      description: "Keep error/warning lines only",
      filter: cargoBuildFilter,
    },
    clippy: {
      description: "Keep error/warning lines only",
      filter: cargoBuildFilter,
    },
  },
};

function resolveFilter(
  registry: Registry,
  command: string,
  subcommand: string,
): FilterFn | null {
  const cmdEntry = registry[command];
  if (!cmdEntry) return null;
  const entry = cmdEntry[subcommand] ?? cmdEntry[""] ?? null;
  if (!entry) return null;
  return entry.filter ?? null;
}

function measure(
  command: string,
  subcommand: string,
  inputLen: number,
  outputLen: number,
): void {
  const sessionId = process.env.AAP_SESSION_ID;
  const metricsDir = process.env.AAP_HOOK_METRICS_DIR;
  const measureEnabled = process.env.AAP_HOOK_MEASURE === "1";
  if (!measureEnabled || !sessionId || !metricsDir) return;

  try {
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session: sessionId,
      command,
      subcommand: subcommand || null,
      input_bytes: inputLen,
      output_bytes: outputLen,
      ratio: inputLen > 0 ? outputLen / inputLen : 1,
    });
    appendFileSync(`${metricsDir}/${sessionId}.jsonl`, line + "\n", "utf8");
  } catch {
    // Measurement is best-effort, never fail the hook
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exit(0);
  }

  if (args[0] === "--list") {
    printRegistry();
    return;
  }

  const command = args[0]!;
  const subcommand = args[1] ?? "";
  const restArgs = args.slice(1);

  const filter = resolveFilter(REGISTRY, command, subcommand);
  if (!filter) {
    pipeStdin();
    return;
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    const output = filter(input, restArgs);
    const inputLen = Buffer.byteLength(input, "utf8");
    const outputLen = Buffer.byteLength(output, "utf8");
    measure(command, subcommand, inputLen, outputLen);
    process.stdout.write(output);
  });
  process.stdin.resume();
}

function printRegistry(): void {
  const output: Record<string, Record<string, { description: string }>> = {};
  for (const [cmd, subs] of Object.entries(REGISTRY)) {
    output[cmd] = {};
    for (const [sub, entry] of Object.entries(subs)) {
      output[cmd]![sub] = { description: entry.description };
    }
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function pipeStdin(): void {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    process.stdout.write(chunk);
  });
  process.stdin.resume();
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("filter-runner.js") ||
    process.argv[1].endsWith("filter-runner.ts") ||
    process.argv[1].endsWith("filter-runner.mjs") ||
    process.argv[1].endsWith("aap-filter.mjs"));

if (isMain) {
  main();
}
