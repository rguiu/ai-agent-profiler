import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * opencode 2.x keeps a shared background service (`opencode serve --service`).
 * A new TUI attaches to it instead of spawning a server of its own, and the
 * daemon keeps the environment — including `OPENCODE_CONFIG_CONTENT`, which is
 * where aap puts the base URLs — of whichever launch started it.
 *
 * Two consequences matter for routing:
 *
 *  - `aap run opencode` must opt out with `--standalone`, or a daemon started
 *    by an earlier launch silently ignores this launch's routing and model;
 *  - `aap route` must warn when such a daemon is still around, because a
 *    "wrapper-free" opencode attaches to it and its traffic is attributed to
 *    the old launch's session.
 */

/**
 * `--standalone` for an opencode launch, unless the caller already chose a
 * server or asked for a private one. Other agents are untouched.
 *
 * opencode's usage is `opencode <subcommand> [flags]`, so when a subcommand is
 * present the flag goes after it (`run --standalone`); flags at the front mean
 * the interactive TUI, where there is no subcommand to place it behind.
 */
export function withStandaloneArgs(
  agent: string,
  agentArgs: string[],
): string[] {
  if (agent !== "opencode") return agentArgs;
  if (agentArgs.includes("--standalone")) return agentArgs;
  // `--server` names an explicit server; a private one would contradict it.
  if (
    agentArgs.some((arg) => arg === "--server" || arg.startsWith("--server="))
  ) {
    return agentArgs;
  }
  const args = [...agentArgs];
  const subcommand = args[0] !== undefined && !args[0].startsWith("-");
  // Only the interactive TUI and `run` are launches. Other subcommands
  // (serve, session, models, …) do not attach to the shared service the same
  // way, and `--standalone` is not a subcommand flag there.
  if (subcommand && args[0] !== "run") return agentArgs;
  const at = subcommand ? 1 : 0;
  args.splice(at, 0, "--standalone");
  return args;
}

/** Path segments that carry a session id in an aap base URL. */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Session ids baked into an opencode config's base URLs.
 *
 * `aap run` writes `<origin>/<session>/<provider><apiPath>`; `aap route` writes
 * `<origin>/<provider><apiPath>`. The second path segment distinguishes them:
 * it is a provider name only when a session id comes first.
 */
export function proxySessionIds(
  configContent: string,
  origin: string,
  providers: readonly string[],
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return [];
  }

  const known = new Set(providers);
  const base = origin.replace(/\/+$/, "") + "/";
  const ids = new Set<string>();
  for (const url of collectStrings(parsed)) {
    if (!url.startsWith(base)) continue;
    const [first, second] = url.slice(base.length).split("/");
    if (!first || !second) continue;
    if (
      known.has(second) &&
      !known.has(first) &&
      SAFE_SESSION_ID_RE.test(first)
    ) {
      ids.add(first);
    }
  }
  return [...ids];
}

function collectStrings(
  value: unknown,
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectStrings(item, out, depth + 1);
    }
  }
  return out;
}

export interface ServiceProbe {
  listPids: () => number[];
  readEnv: (pid: number) => string | null;
}

export interface RoutingHazard {
  kind: "env" | "service";
  /** Set for `kind: "service"`. */
  pid?: number;
  sessionIds: string[];
}

/**
 * Places where opencode would use a launcher's session instead of the config
 * file: this shell's environment, and any shared service still running.
 */
export function findRoutingHazards(opts: {
  origin: string;
  providers: readonly string[];
  env: NodeJS.ProcessEnv;
  probe: ServiceProbe;
}): RoutingHazard[] {
  const hazards: RoutingHazard[] = [];

  const envContent = opts.env.OPENCODE_CONFIG_CONTENT;
  if (envContent) {
    const sessionIds = proxySessionIds(envContent, opts.origin, opts.providers);
    if (sessionIds.length > 0) hazards.push({ kind: "env", sessionIds });
  }

  for (const pid of opts.probe.listPids()) {
    const content = envValue(
      opts.probe.readEnv(pid),
      "OPENCODE_CONFIG_CONTENT",
    );
    if (!content) continue;
    const sessionIds = proxySessionIds(content, opts.origin, opts.providers);
    if (sessionIds.length > 0)
      hazards.push({ kind: "service", pid, sessionIds });
  }

  return hazards;
}

/** Human-readable lines for `aap route`; empty when there is nothing to say. */
export function formatRoutingHazards(hazards: RoutingHazard[]): string[] {
  const lines: string[] = [];
  for (const hazard of hazards) {
    const sessions = hazard.sessionIds.join(", ");
    if (hazard.kind === "env") {
      lines.push(
        `warn: OPENCODE_CONFIG_CONTENT is set in this shell (session ${sessions}).`,
        `      opencode launched from here ignores the config file. Run it from a clean shell.`,
      );
    } else {
      lines.push(
        `warn: opencode's shared service (pid ${hazard.pid}) still routes to session ${sessions}.`,
        `      Raw opencode attaches to it. Run \`opencode service stop\` from a clean shell.`,
      );
    }
  }
  return lines;
}

/** PIDs of the shared `opencode serve --service` daemon(s). */
export function listOpenCodeServicePids(): number[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    });
  } catch {
    return [];
  }

  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (!/\/opencode(?:\.exe)?\s+serve\s+--service(?:\s|$)/.test(match[2]!)) {
      continue;
    }
    pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * A process's environment. `/proc` on Linux is NUL-separated; macOS only
 * exposes it through `ps eww`, whose output appends space-separated `K=V`.
 * Any other platform reports nothing rather than guessing.
 */
export function readProcessEnv(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return readFileSync(`/proc/${String(pid)}/environ`, "utf8");
    }
    if (process.platform === "darwin") {
      return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
    }
    return null;
  } catch {
    return null;
  }
}

export const opencodeServiceProbe: ServiceProbe = {
  listPids: listOpenCodeServicePids,
  readEnv: readProcessEnv,
};

function envValue(text: string | null, key: string): string | undefined {
  if (!text) return undefined;
  const entries = text.includes("\0") ? text.split("\0") : text.split(/\s+/);
  const prefix = `${key}=`;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}
