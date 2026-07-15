import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AAP_DIR = join(homedir(), ".aap");
const BIN_DIR = join(AAP_DIR, "bin");
const FILTER_JS = join(BIN_DIR, "aap-filter.mjs");
const __dirname = dirname(fileURLToPath(import.meta.url));

const CLEAN_PATH = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin";

const COMMANDS: ReadonlyArray<{ name: string; fallback: string }> = [
  { name: "git", fallback: "/usr/bin/git" },
  { name: "ls", fallback: "/bin/ls" },
  { name: "grep", fallback: "/usr/bin/rg" },
  { name: "node", fallback: process.execPath },
  { name: "find", fallback: "/usr/bin/find" },
  { name: "cat", fallback: "/bin/cat" },
  { name: "npm", fallback: "/usr/local/bin/npm" },
  { name: "cargo", fallback: `${homedir()}/.cargo/bin/cargo` },
];

function resolveBin(name: string, fallback: string): string {
  try {
    return (
      execFileSync("which", [name], {
        encoding: "utf8",
        env: { PATH: CLEAN_PATH },
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
}

function readTemplate(name: string): string {
  return readFileSync(join(__dirname, "templates", name), "utf8");
}

function findFilterRunner(): string | null {
  const compiled = join(
    __dirname,
    "..",
    "..",
    "dist",
    "hook",
    "filter-runner.js",
  );
  if (existsSync(compiled)) return compiled;
  return null;
}

export function hooksPath(): string {
  return BIN_DIR;
}

export function ensureHooksInstalled(): boolean {
  mkdirSync(BIN_DIR, { recursive: true });

  const template = readTemplate("wrapper.sh");
  const filterRunner = findFilterRunner();
  const nodeBin = resolveBin("node", process.execPath);

  for (const cmd of COMMANDS) {
    const dest = join(BIN_DIR, cmd.name);
    const binPath = resolveBin(cmd.name, cmd.fallback);
    const content = template
      .replaceAll("__REAL_BIN__", binPath)
      .replaceAll("__NODE_BIN__", nodeBin)
      .replaceAll("__COMMAND__", cmd.name)
      .replaceAll("__FILTER_RUNNER__", FILTER_JS);

    const current = existsSync(dest) ? readFileSync(dest, "utf8") : "";
    if (current !== content) {
      writeFileSync(dest, content, "utf8");
      chmodSync(dest, 0o755);
      process.stderr.write(`aap: hook ${cmd.name} → ${dest} (${binPath})\n`);
    }
  }

  if (filterRunner) {
    const currentRunner = existsSync(FILTER_JS)
      ? readFileSync(FILTER_JS, "utf8")
      : "";
    const newRunner = readFileSync(filterRunner, "utf8");
    if (currentRunner !== newRunner) {
      copyFileSync(filterRunner, FILTER_JS);
      chmodSync(FILTER_JS, 0o755);
      process.stderr.write(`aap: filter-runner → ${FILTER_JS}\n`);
    }
  } else {
    process.stderr.write(
      "aap: warning — dist/hook/filter-runner.js not found. Run 'npm run build' first.\n",
    );
  }

  const rgDest = join(BIN_DIR, "rg");
  if (!existsSync(rgDest)) {
    const grepContent = existsSync(join(BIN_DIR, "grep"))
      ? readFileSync(join(BIN_DIR, "grep"), "utf8")
      : "";
    if (grepContent) {
      writeFileSync(rgDest, grepContent, "utf8");
      chmodSync(rgDest, 0o755);
    }
  }

  return true;
}

export function hooksInstalled(): boolean {
  return existsSync(BIN_DIR) && existsSync(join(BIN_DIR, "git"));
}

export function uninstallHooks(): boolean {
  if (!existsSync(BIN_DIR)) return false;

  let removed = 0;
  for (const cmd of COMMANDS) {
    const dest = join(BIN_DIR, cmd.name);
    if (!existsSync(dest)) continue;
    const content = readFileSync(dest, "utf8");
    if (
      !content.includes("__FILTER_RUNNER__") &&
      !content.includes("__REAL_BIN__")
    ) {
      continue;
    }
    try {
      unlinkSync(dest);
      removed++;
    } catch {
      // best effort
    }
  }

  const rgDest = join(BIN_DIR, "rg");
  try {
    if (existsSync(rgDest)) unlinkSync(rgDest);
  } catch {
    // best effort
  }

  try {
    if (existsSync(FILTER_JS)) unlinkSync(FILTER_JS);
  } catch {
    // best effort
  }

  process.stderr.write(`aap: removed ${removed} hooks\n`);
  return removed > 0;
}
