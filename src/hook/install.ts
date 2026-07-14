import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AAP_DIR = join(homedir(), ".aap");
const BIN_DIR = join(AAP_DIR, "bin");
const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBin(name: string): string {
  try {
    return (
      execFileSync("which", [name], { encoding: "utf8" }).trim() ||
      `/usr/bin/${name}`
    );
  } catch {
    return name === "cargo"
      ? `${homedir()}/.cargo/bin/cargo`
      : `/usr/bin/${name}`;
  }
}

function readTemplate(name: string): string {
  return readFileSync(join(__dirname, "templates", name), "utf8");
}

export function hooksPath(): string {
  return BIN_DIR;
}

export function ensureHooksInstalled(): boolean {
  mkdirSync(BIN_DIR, { recursive: true });

  const wrappers: [string, string, string][] = [
    ["git", readTemplate("git.sh"), resolveBin("git")],
    ["ls", readTemplate("ls.sh"), resolveBin("ls")],
    ["grep", readTemplate("grep.sh"), resolveBin("rg")],
    ["node", readTemplate("node.sh"), resolveBin("node")],
    ["find", readTemplate("find.sh"), resolveBin("find")],
    ["cat", readTemplate("cat.sh"), resolveBin("cat")],
    ["npm", readTemplate("npm.sh"), resolveBin("npm")],
  ];

  for (const [name, template, binPath] of wrappers) {
    const dest = join(BIN_DIR, name);
    const content = template.replaceAll("__REAL_BIN__", binPath);
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : "";
    if (current !== content) {
      writeFileSync(dest, content, "utf8");
      chmodSync(dest, 0o755);
      process.stderr.write(`aap: hook ${name} → ${dest} (${binPath})\n`);
    }
  }

  // rg -> grep symlink
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
