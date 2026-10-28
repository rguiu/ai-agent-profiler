import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { loadConfig } from "../config/index.js";
import {
  CLIENT_IDS,
  clientConfigPath,
  clientPatch,
  isRouted,
  mergeConfig,
  type ClientId,
} from "../routing/route-config.js";

const BACKUP_SUFFIX = ".aap-backup";
const MARKER_VERSION = 1;

interface Marker {
  version: number;
  origin: string;
  files: { path: string; existed: boolean }[];
}

interface Options {
  write: boolean;
  undo: boolean;
  cacheTtl?: "1h";
  clients: ClientId[];
}

/**
 * `aap route` — point agents at the proxy without a launcher.
 *
 * Reads the client config files agents already load and reports whether they are
 * routed; `--write` applies the edits (with a backup + a marker so `--undo` is
 * exact). This is the wrapper-free path: the base URL is constant, and sessions
 * are attributed from the request (Claude Code sends `x-claude-code-session-id`).
 */
export async function route(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.undo) {
    undo(homedir());
    return;
  }

  // Plain loadConfig, like `aap run`: only providers the user configured are
  // routed. The built-ins serve adds (ollama-cloud) must not leak into a
  // client's config file.
  const config = loadConfig();
  const origin = `http://${config.server.host}:${config.server.port}`;
  const healthy = await probe(origin);

  printHealth(origin, healthy);

  const targets = opts.clients.length > 0 ? opts.clients : [...CLIENT_IDS];
  const applied: { client: ClientId; path: string }[] = [];

  for (const client of targets) {
    const path = clientConfigPath(client, homedir());
    if (client === "ollama") {
      printOllama(origin);
      continue;
    }
    const patch = clientPatch(client, origin, config.providers, {
      env: process.env,
      cacheTtl: opts.cacheTtl,
    });
    if (Object.keys(patch).length === 0) {
      console.log(
        `\n${label(client)}: no matching provider in config — skipped`,
      );
      continue;
    }
    const existing = readJson(path);
    if (existing === "broken") {
      console.log(
        `\n${label(client)}: ${displayPath(path)} is not valid JSON — fix it first, nothing written`,
      );
      continue;
    }
    const routed = existing !== null && isRouted(client, existing, origin);

    console.log(`\n${label(client)}  ${displayPath(path)}`);
    console.log(`  state:  ${stateLabel(existing, routed, origin)}`);
    console.log(`  patch:  ${JSON.stringify(patch)}`);

    if (!opts.write) continue;
    if (routed) {
      console.log(`  ...already routed, left untouched`);
      continue;
    }
    applyPatch(path, existing, patch, origin);
    applied.push({ client, path });
    console.log(
      `  wrote:  ${displayPath(path)} (original kept as ${BACKUP_SUFFIX})`,
    );
  }

  if (opts.write) {
    if (applied.length === 0) {
      console.log(`\nNothing to do — all selected clients are already routed.`);
    } else {
      console.log(
        `\nRouted ${applied.length} client(s). Start the proxy with \`aap serve\`.`,
      );
      console.log(
        `Claude Code sends its own session id, so sessions are attributed per`,
      );
      console.log(
        `conversation. opencode/pi have no session id: their traffic is grouped`,
      );
      console.log(
        `as unattributed-<client>-… and split after [sessions].idleTimeoutMs.`,
      );
      console.log(`Undo with \`aap route --undo\`.`);
    }
  } else if (targets.some((c) => c !== "ollama")) {
    console.log(
      `\nRe-run with \`aap route --write\` to apply, or \`aap route --write claude\` for one client.`,
    );
    console.log(
      `Claude Code optimisations (ENABLE_TOOL_SEARCH, CLAUDE_CODE_AUTO_MODE_SERVER)`,
    );
    console.log(
      `are written into the same settings file; add --cache-1h for the 1h prompt cache.`,
    );
  }
}

function parseArgs(args: string[]): Options {
  let write = false;
  let undo = false;
  let cacheTtl: "1h" | undefined;
  const clients: ClientId[] = [];
  for (const arg of args) {
    if (arg === "--write") write = true;
    else if (arg === "--undo") undo = true;
    else if (arg === "--cache-1h") cacheTtl = "1h";
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: aap route [--write] [--undo] [--cache-1h] [claude|opencode|pi|ollama ...]",
      );
      process.exit(0);
    } else if ((CLIENT_IDS as readonly string[]).includes(arg)) {
      clients.push(arg as ClientId);
    } else {
      console.error(`aap route: unknown argument "${arg}"`);
      process.exitCode = 1;
    }
  }
  return { write, undo, cacheTtl, clients };
}

async function probe(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function printHealth(origin: string, healthy: boolean): void {
  console.log(`aap route — point agents at the profiler without a launcher\n`);
  console.log(
    `proxy:  ${origin}  ${healthy ? "ok" : "UNREACHABLE (start it with `aap serve`)"}`,
  );
}

function printOllama(origin: string): void {
  const routed = process.env.OLLAMA_HOST === origin;
  console.log(`\n${label("ollama")}  (shell environment)`);
  console.log(
    `  state:    ${routed ? "routed" : "not set in this shell (add to your shell profile)"}`,
  );
  console.log(
    `  patch:    export OLLAMA_HOST=${origin}  # the Ollama daemon relays :cloud models`,
  );
}

function applyPatch(
  path: string,
  existing: Record<string, unknown> | null,
  patch: Record<string, unknown>,
  origin: string,
): void {
  const merged = mergeConfig(existing ?? {}, patch);
  mkdirSync(dirname(path), { recursive: true });
  const backup = path + BACKUP_SUFFIX;
  // Keep the first backup as the pristine original: re-writing an already
  // routed file must not overwrite it with the routed copy.
  if (existing !== null && !existsSync(backup)) {
    writeFileSync(backup, JSON.stringify(existing, null, 2) + "\n");
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  recordMarker(path, existing !== null, origin);
}

function recordMarker(path: string, existed: boolean, origin: string): void {
  const markerPath = markerPathFor(homedir());
  const marker = readMarker(markerPath);
  const files = marker?.files ?? [];
  if (!files.some((f) => f.path === path)) {
    files.push({ path, existed });
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({ version: MARKER_VERSION, origin, files }, null, 2) + "\n",
  );
}

function undo(home: string): void {
  const markerPath = markerPathFor(home);
  const marker = readMarker(markerPath);
  if (!marker || marker.files.length === 0) {
    console.log("aap route: nothing to undo (no routing applied by aap).");
    return;
  }
  for (const file of marker.files) {
    const backup = file.path + BACKUP_SUFFIX;
    if (file.existed && existsSync(backup)) {
      renameSync(backup, file.path);
      console.log(`restored ${displayPath(file.path)}`);
    } else {
      // No original file: remove what we created.
      rmSync(file.path, { force: true });
      console.log(`removed  ${displayPath(file.path)}`);
    }
  }
  rmSync(markerPath, { force: true });
  console.log("aap route: routing removed.");
}

function readMarker(path: string): Marker | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Marker;
  } catch {
    return null;
  }
}

function markerPathFor(home: string): string {
  return `${home}/.aap/routing.json`;
}

/** Parsed config, `null` when the file doesn't exist, `"broken"` when invalid. */
function readJson(path: string): Record<string, unknown> | null | "broken" {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return "broken";
    return parsed as Record<string, unknown>;
  } catch {
    return "broken";
  }
}

function stateLabel(
  existing: Record<string, unknown> | null,
  routed: boolean,
  origin: string,
): string {
  if (existing === null) return "no config file yet (it will be created)";
  if (routed) return "routed";
  if (pointsElsewhere(existing)) return "routes somewhere else — not routed";
  return `not routed (proxy is ${origin})`;
}

function pointsElsewhere(config: unknown): boolean {
  const hits: string[] = [];
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (/^https?:\/\//.test(value)) hits.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(config);
  return hits.length > 0;
}

function label(client: ClientId): string {
  return {
    claude: "claude-code",
    opencode: "opencode",
    pi: "pi",
    ollama: "ollama",
  }[client].padEnd(11);
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
