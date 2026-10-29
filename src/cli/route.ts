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
import { loadConfig, withBuiltinProviders } from "../config/index.js";
import {
  CLIENT_IDS,
  clientConfigPath,
  clientPatch,
  isRouted,
  mergeConfig,
  type ClientId,
} from "../routing/route-config.js";
import { proxyOrigin } from "../routing/origin.js";
import {
  ollamaShellState,
  removeOllamaBlock,
  shellProfilePath,
  upsertOllamaBlock,
} from "../routing/shell-profile.js";

const BACKUP_SUFFIX = ".aap-backup";
const MARKER_VERSION = 1;

interface Marker {
  version: number;
  origin: string;
  files: { path: string; existed: boolean; kind?: "json" | "shell" }[];
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

  // Built-ins included on purpose: opencode resolves a model id to a provider
  // that has to exist in its own config, and `ollama-cloud/<model>` is in
  // opencode's catalog. Without the entry opencode sends that model straight to
  // ollama.com, so the run is real but untraced. Only the opencode patch is
  // built from the provider map (claude and pi name their providers
  // explicitly), so no other client grows a built-in.
  const config = withBuiltinProviders(loadConfig());
  const origin = proxyOrigin(config.server);
  const healthy = await probe(origin);

  printHealth(origin, healthy);

  const targets = opts.clients.length > 0 ? opts.clients : [...CLIENT_IDS];
  const applied: { client: ClientId; path: string }[] = [];

  for (const client of targets) {
    if (client === "ollama") {
      const path = routeOllama(origin, opts.write);
      if (path !== null) applied.push({ client, path });
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
    const path = clientConfigPath(client, homedir());
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
      if (applied.some((entry) => entry.client === "ollama")) {
        console.log(
          `Open a new terminal (or \`exec $SHELL\`) so the \`ollama\` shell function`,
        );
        console.log(`is loaded before the next \`ollama launch\`.`);
      }
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

/**
 * Route `ollama launch <agent>`. Unlike Claude Code, opencode and pi, ollama
 * takes no config file of its own for this: it builds the agent's inline config
 * from `OLLAMA_HOST` at launch time, which overrides the provider entries
 * `aap route` writes for opencode/pi. The only lever is the environment, so the
 * managed block lives in the login profile and scopes the redirect to `launch`.
 *
 * Returns the profile path when this run changed it.
 */
function routeOllama(origin: string, write: boolean): string | null {
  const home = homedir();
  const path = shellProfilePath(home, process.env);
  console.log(
    `\n${label("ollama")}  ${path === null ? `(unsupported $SHELL "${process.env.SHELL ?? ""}")` : displayPath(path)}`,
  );

  const block = `ollama() { … OLLAMA_HOST='${origin}' command ollama "$@" … }  # \`launch\` only`;
  if (path === null) {
    console.log(`  state:  not routed`);
    console.log(`  patch:  ${block}`);
    console.log(
      `\n  aap route only edits zsh and bash profiles; add this function yourself.`,
    );
    return null;
  }

  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const state = ollamaShellState(text);
  const routed = state.managed
    ? state.managedOrigin === origin
    : state.exportedOrigin === origin;
  console.log(`  state:  ${ollamaStateLabel(state, origin, routed)}`);
  console.log(`  patch:  ${block}`);

  if (!write) return null;
  if (routed) {
    console.log(
      state.managed
        ? `  ...already routed, left untouched`
        : `  ...your export already routes it; left untouched (it also moves \`ollama serve\`'s bind address)`,
    );
    return null;
  }

  const backup = path + BACKUP_SUFFIX;
  const existed = existsSync(path);
  // Keep the first backup pristine so it is still the file the user had before
  // `aap route` touched anything.
  if (existed && !existsSync(backup)) {
    writeFileSync(backup, text);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, upsertOllamaBlock(text, origin));
  recordMarker(path, existed, origin, "shell");
  console.log(
    existed
      ? `  wrote:  ${displayPath(path)} (original kept as ${BACKUP_SUFFIX})`
      : `  wrote:  ${displayPath(path)} (created)`,
  );
  return path;
}

function ollamaStateLabel(
  state: ReturnType<typeof ollamaShellState>,
  origin: string,
  routed: boolean,
): string {
  if (routed) {
    return state.managed
      ? "routed"
      : `routed (OLLAMA_HOST exported in this file)`;
  }
  if (state.managed) {
    return `routed to ${state.managedOrigin ?? "an unreadable value"} — not ${origin} (will be updated)`;
  }
  if (state.exportedOrigin) {
    return `not routed — OLLAMA_HOST is exported to ${state.exportedOrigin}`;
  }
  return `not routed (proxy is ${origin})`;
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
  recordMarker(path, existing !== null, origin, "json");
}

function recordMarker(
  path: string,
  existed: boolean,
  origin: string,
  kind: "json" | "shell",
): void {
  const markerPath = markerPathFor(homedir());
  const marker = readMarker(markerPath);
  const files = marker?.files ?? [];
  if (!files.some((f) => f.path === path)) {
    files.push({ path, existed, kind });
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
    if (file.kind === "shell") {
      undoShellProfile(file.path, file.existed);
      continue;
    }
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

/**
 * Remove only the managed block from a shell profile. Restoring the backup
 * would also throw away anything the user added after `aap route --write`.
 */
function undoShellProfile(path: string, existed: boolean): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const remaining = removeOllamaBlock(text);
  if (remaining === text) return;

  if (!existed && remaining.trim().length === 0) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, remaining);
  }
  // The backup was a safety net for the edit we just reverted; keeping it would
  // leave a stale copy of the profile next to the real one.
  rmSync(path + BACKUP_SUFFIX, { force: true });
  console.log(`removed  aap's ollama block from ${displayPath(path)}`);
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
