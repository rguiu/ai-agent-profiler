import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureClaudeMd, introspectionsDir } from "./intro.js";

function defaultExamplePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fromModule = join(moduleDir, "..", "..", "config.example.toml");
  if (existsSync(fromModule)) return fromModule;

  const fromCwd = join(process.cwd(), "config.example.toml");
  if (existsSync(fromCwd)) return fromCwd;

  throw new Error("config.example.toml not found");
}

function deepCompare(
  example: Record<string, unknown>,
  existing: Record<string, unknown>,
  prefix: string[] = [],
): string[][] {
  const missing: string[][] = [];
  for (const [key, value] of Object.entries(example)) {
    const path = [...prefix, key];
    if (!(key in existing)) {
      missing.push(path);
    } else if (isRecord(value) && isRecord(existing[key])) {
      missing.push(
        ...deepCompare(value, existing[key] as Record<string, unknown>, path),
      );
    }
  }
  return missing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildNested(path: string[], value: unknown): Record<string, unknown> {
  const key = path[0]!;
  if (path.length === 1) {
    return { [key]: value };
  }
  return { [key]: buildNested(path.slice(1), value) };
}

function getValueAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function seedConfig(
  dest: string,
  example: Record<string, unknown>,
  dataDir: string,
): void {
  const seeded = deepMerge(
    structuredClone(example) as Record<string, unknown>,
    { storage: { dir: dataDir } },
  );
  writeFileSync(dest, stringifyToml(seeded));
}

function logAdded(missing: string[][]): void {
  const sections = new Map<string, string[]>();
  for (const path of missing) {
    const section =
      path.length > 1 ? `[${path.slice(0, -1).join(".")}]` : `[${path[0]}]`;
    const key = path[path.length - 1]!;
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(key);
  }
  for (const [section, keys] of sections) {
    console.log(`  ${section}: added ${keys.join(", ")}`);
  }
}

export function install(opts?: {
  home?: string;
  examplePath?: string;
  dataDir?: string;
}): void {
  const home = opts?.home ?? homedir();
  const aapHome = join(home, ".aap");
  const configDest = join(aapHome, "config.toml");
  const dataDir = opts?.dataDir ?? join(aapHome, "data");
  const examplePath = opts?.examplePath ?? defaultExamplePath();

  mkdirSync(aapHome, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const introDir = introspectionsDir(home);
  ensureClaudeMd(introDir);
  console.log(`created ${introDir}/CLAUDE.md`);

  const exampleRaw = readFileSync(examplePath, "utf8");
  let example: Record<string, unknown>;
  try {
    example = parseToml(exampleRaw) as Record<string, unknown>;
  } catch (err) {
    console.error(`Cannot parse example config: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!existsSync(configDest)) {
    seedConfig(configDest, example, dataDir);
    console.log(`created ${configDest}`);
    return;
  }

  const existingRaw = readFileSync(configDest, "utf8");
  let existing: Record<string, unknown>;
  try {
    existing = parseToml(existingRaw) as Record<string, unknown>;
  } catch (err) {
    console.error(
      `Cannot parse existing config at ${configDest}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const missing = deepCompare(example, existing);
  if (missing.length === 0) {
    console.log("config is up to date");
    return;
  }

  const additions: Record<string, unknown> = {};
  for (const path of missing) {
    const value = getValueAtPath(example, path);
    const nested = buildNested(path, value);
    for (const [key, val] of Object.entries(nested)) {
      if (key in additions) {
        additions[key] = deepMerge(
          additions[key] as Record<string, unknown>,
          val as Record<string, unknown>,
        );
      } else {
        additions[key] = val;
      }
    }
  }

  const append = `\n# ADDED by aap install\n${stringifyToml(additions)}`;
  let result = existingRaw;
  if (!result.endsWith("\n")) result += "\n";
  result += append;
  writeFileSync(configDest, result);

  logAdded(missing);
  console.log(`merged ${missing.length} new field(s) into ${configDest}`);
}
