import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { loadConfig, type Config } from "../config/index.js";
import { ensureHooksInstalled, hooksPath } from "../hook/install.js";
import type { SessionInfo } from "../session/index.js";

const PROVIDER_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
};

export function buildProviderEnv(
  agent: string,
  config: Pick<Config, "providers">,
  origin: string,
  sessionId: string,
  env?: NodeJS.ProcessEnv,
): Record<string, string> {
  if (agent === "opencode") {
    const provider: Record<string, { options: { baseURL: string } }> = {};
    for (const [name, cfg] of Object.entries(config.providers)) {
      const apiPath = cfg.apiPath ?? "/v1";
      provider[name] = {
        options: { baseURL: `${origin}/${sessionId}/${name}${apiPath}` },
      };
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) };
  }

  const out: Record<string, string> = {};
  for (const name of Object.keys(config.providers)) {
    const varName = PROVIDER_ENV[name];
    if (varName) out[varName] = `${origin}/${sessionId}/${name}`;
  }

  // Ollama CLI talks to its native API and only honours OLLAMA_HOST (scheme+
  // host+port, no path). Point it at the proxy; requests are attributed to this
  // session via meta.ollama (see run()), matched by path in parseRoute.
  if (agent === "ollama" && config.providers.ollama) {
    out.OLLAMA_HOST = origin;
  }

  // Bedrock: Claude Code uses ANTHROPIC_BEDROCK_BASE_URL (not the AWS SDK env var).
  // The SDK sends requests to /model/{id}/converse-stream on this host.
  const useBedrock = env?.CLAUDE_CODE_USE_BEDROCK;
  if (useBedrock && useBedrock !== "0" && config.providers.bedrock) {
    out.ANTHROPIC_BEDROCK_BASE_URL = origin;
  }

  return out;
}

// Claude Code caches its tool definitions per ANTHROPIC_BASE_URL; routing it
// through the proxy changes that URL and invalidates the cache, so every
// request resends the full tool list. ENABLE_TOOL_SEARCH defers tool schemas
// instead, keeping the cache valid. Default it on for Claude Code unless the
// caller already set it explicitly — but only when the endpoint actually serves
// a first-party Anthropic model. Deferred custom tools are only supported on
// Anthropic models (upstream #89211); forcing ENABLE_TOOL_SEARCH=true for a
// non-Anthropic endpoint (DeepSeek/Bedrock/Ollama/gateway) yields a 400.
export function buildToolSearchEnv(
  agent: string,
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "providers">,
): Record<string, string> {
  if (agent !== "claude" || env.ENABLE_TOOL_SEARCH !== undefined) {
    return {};
  }
  return isFirstPartyAnthropic(config, env)
    ? { ENABLE_TOOL_SEARCH: "true" }
    : {};
}

// True when Claude Code will be talking to a first-party Anthropic endpoint.
// Bedrock is a distinct API (AWS), not the Anthropic messages endpoint, so it
// is not first-party here. Otherwise we trust the `anthropic` provider's
// upstream host: only api.anthropic.com (or an *.anthropic.com enterprise
// endpoint) counts. A third-party gateway serving a real Anthropic model is
// deliberately left "not first-party" — the safe default is to not force true.
export function isFirstPartyAnthropic(
  config: Pick<Config, "providers">,
  env: NodeJS.ProcessEnv,
): boolean {
  const useBedrock =
    env.CLAUDE_CODE_USE_BEDROCK && env.CLAUDE_CODE_USE_BEDROCK !== "0";
  if (useBedrock) return false;

  const upstream = config.providers.anthropic?.upstream;
  if (!upstream) return false;

  try {
    const host = new URL(upstream).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

// A caller may pin the session id (e.g. a benchmark harness that needs to tag
// the session with a verify result afterwards). Otherwise a fresh id is used.
export function resolveSessionId(env: NodeJS.ProcessEnv): string {
  const provided = env.AAP_SESSION_ID;
  if (provided && /^[A-Za-z0-9._-]+$/.test(provided)) return provided;
  return randomUUID();
}

export function parseRunArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  meta: Record<string, string>;
  agent?: string;
  agentArgs: string[];
  cacheTtl?: "1h";
  hooks?: boolean;
} {
  const meta: Record<string, string> = {};
  let cacheTtl: "1h" | undefined;
  let hooks: boolean | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AAP_META_") && value) {
      meta[key.slice("AAP_META_".length).toLowerCase()] = value;
    }
  }
  if (env.ARMADA_NODE_NAME) meta.armada_node = env.ARMADA_NODE_NAME;
  if (env.AAP_CACHE_TTL === "1h") cacheTtl = "1h";
  if (env.AAP_HOOK_MODE === "1" || env.AAP_HOOK_MODE === "true") hooks = true;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--meta") {
      const pair = args[i + 1];
      if (pair !== undefined) {
        const eq = pair.indexOf("=");
        if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      i += 2;
    } else if (args[i] === "--cache-1h") {
      cacheTtl = "1h";
      i += 1;
    } else if (args[i] === "--hooks") {
      hooks = true;
      i += 1;
    } else if (args[i] === "--no-hooks") {
      hooks = false;
      i += 1;
    } else {
      break;
    }
  }
  return {
    meta,
    agent: args[i],
    agentArgs: args.slice(i + 1),
    cacheTtl,
    hooks,
  };
}

export async function run(args: string[]): Promise<void> {
  const { meta, agent, agentArgs, cacheTtl, hooks } = parseRunArgs(
    args,
    process.env,
  );
  if (!agent) {
    console.error(
      "Usage: aap run [--cache-1h] [--hooks] [--meta key=value ...] <agent> [args...]",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const sessionId = resolveSessionId(process.env);
  const host = normalizeHost(config.server.host);
  const origin = `http://${host}:${config.server.port}`;
  const cwd = process.cwd();

  const overrides = buildProviderEnv(
    agent,
    config,
    origin,
    sessionId,
    process.env,
  );
  if (overrides.ANTHROPIC_BEDROCK_BASE_URL) {
    meta.bedrock = "1";
  }
  if (overrides.OLLAMA_HOST) {
    meta.ollama = "1";
  }
  if (cacheTtl === "1h") {
    meta.cache_ttl = "1h";
    console.error(`aap: cache TTL upgraded to 1h (from 5m)`);
  }
  if (hooks) {
    meta.hooks = "1";
  }

  const toolSearchOverrides = buildToolSearchEnv(agent, process.env, config);

  const session: SessionInfo = {
    id: sessionId,
    client: agent,
    cwd,
    repo: detectRepo(cwd),
    startedAt: new Date().toISOString(),
    meta: Object.keys(meta).length > 0 ? meta : null,
  };
  await registerSession(origin, session);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    ...toolSearchOverrides,
  };

  console.error(`aap: session ${sessionId} (cwd ${cwd})`);
  if (agent === "claude" && process.env.ENABLE_TOOL_SEARCH === undefined) {
    if (toolSearchOverrides.ENABLE_TOOL_SEARCH) {
      console.error(
        `aap: ENABLE_TOOL_SEARCH=true (claude + first-party Anthropic endpoint)`,
      );
    } else {
      console.error(
        `aap: ENABLE_TOOL_SEARCH left unset (claude + non-Anthropic endpoint)`,
      );
    }
  }
  if (overrides.OPENCODE_CONFIG_CONTENT) {
    console.error(
      `aap: routing opencode via OPENCODE_CONFIG_CONTENT (providers: ${Object.keys(config.providers).join(", ")})`,
    );
  } else if (Object.keys(overrides).length > 0) {
    for (const [key, value] of Object.entries(overrides)) {
      console.error(`aap: ${key}=${value}`);
    }
  } else {
    const hasBedrock =
      process.env.CLAUDE_CODE_USE_BEDROCK &&
      process.env.CLAUDE_CODE_USE_BEDROCK !== "0";
    if (hasBedrock && !config.providers.bedrock) {
      console.error(
        `aap: warning — CLAUDE_CODE_USE_BEDROCK is set but no [providers.bedrock] in config. Add it to capture Bedrock traffic.`,
      );
    } else {
      console.error(
        `aap: warning — no base-URL routing set for "${agent}" (no matching provider)`,
      );
    }
  }

  ensureHooksInstalled();
  if (hooks) {
    env.PATH = `${hooksPath()}:${env.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
    env.AAP_HOOK_MEASURE = process.env.AAP_HOOK_MEASURE ?? "1";
    env.AAP_HOOK_METRICS_DIR =
      process.env.AAP_HOOK_METRICS_DIR ?? join(dirname(hooksPath()), "metrics");
    console.error(
      `aap: shell hooks active (metrics: ${env.AAP_HOOK_METRICS_DIR})`,
    );
  }

  const child = spawn(agent, agentArgs, { stdio: "inherit", env });

  const keepAlive = env.AAP_KEEP_ALIVE === "1";
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  if (keepAlive) {
    const ttlMs = cacheTtl === "1h" ? 3_600_000 : 300000;
    const intervalMs = ttlMs * 0.8;
    const primaryProvider = resolvePrimaryProvider(config, agent);
    console.error(
      `aap: keep-alive active (interval ${Math.round(intervalMs / 1000)}s, provider ${primaryProvider}, cache ${cacheTtl === "1h" ? "1h" : "5m"})`,
    );
    keepAliveTimer = setInterval(() => {
      sendKeepAlivePing(origin, sessionId, primaryProvider).catch(() => {});
    }, intervalMs);
    keepAliveTimer.unref();
  }

  child.on("error", (err) => {
    console.error(`aap: failed to launch "${agent}": ${err.message}`);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exit(code ?? (signal ? 1 : 0));
  });

  addTerminationHandlers(child, keepAliveTimer);
}

const SHUTDOWN_TIMEOUT_MS = 5000;

function addTerminationHandlers(
  child: ChildProcess,
  keepAliveTimer: ReturnType<typeof setInterval> | null,
): void {
  let shuttingDown = false;

  function cleanup(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;

    if (keepAliveTimer) clearInterval(keepAliveTimer);

    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill(signal);

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      process.exitCode = 1;
      process.exit();
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
  }

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));

  process.on("exit", () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
}

function normalizeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function resolvePrimaryProvider(config: Config, agent: string): string {
  const providers = Object.keys(config.providers);
  if (providers.length === 1) return providers[0]!;
  if (agent === "opencode")
    return "deepseek" in config.providers ? "deepseek" : providers[0]!;
  if (agent === "claude")
    return "anthropic" in config.providers ? "anthropic" : providers[0]!;
  return providers[0]!;
}

async function sendKeepAlivePing(
  origin: string,
  sessionId: string,
  provider: string,
): Promise<void> {
  try {
    const bodyRes = await fetch(
      `${origin}/_control/sessions/${encodeURIComponent(sessionId)}/last-body`,
    );
    if (!bodyRes.ok) return;
    const { body, path } = (await bodyRes.json()) as {
      body: string | null;
      path: string | null;
    };
    if (!body || !path) return;

    const res = await fetch(`${origin}/${sessionId}/${provider}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aap-keep-alive": "1",
      },
      body,
    });
    if (!res.ok) {
      console.error(`aap: keep-alive ping failed HTTP ${res.status}`);
    }
  } catch {
    // Proxy not running or network error — silent, will retry next interval
  }
}

export async function registerSession(
  origin: string,
  session: SessionInfo,
): Promise<void> {
  try {
    const res = await fetch(`${origin}/_control/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(session),
    });
    if (!res.ok) {
      console.error(`aap: session registration returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(
      `aap: could not reach proxy at ${origin} — is 'aap serve' running? (${(err as Error).message})`,
    );
  }
}

function detectRepo(cwd: string): string | null {
  return (
    tryGit(["config", "--get", "remote.origin.url"], cwd) ??
    tryGit(["rev-parse", "--show-toplevel"], cwd)
  );
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = out.toString().trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
