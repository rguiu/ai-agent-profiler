import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { loadConfig, type Config } from "../config/index.js";
import { ensureHooksInstalled, hooksPath } from "../hook/install.js";
import {
  autoModeEnv,
  isFirstPartyAnthropic as isFirstPartyAnthropicEndpoint,
  toolSearchEnv,
} from "../routing/claude-env.js";
import { lookup } from "node:dns/promises";
import { ollamaAliasHostname, proxyOrigin } from "../routing/origin.js";
import { detectRepo, type SessionInfo } from "../session/index.js";
import { planOllamaLaunch } from "./run-ollama.js";

export function isFirstPartyAnthropic(
  config: Pick<Config, "providers">,
  env: NodeJS.ProcessEnv,
): boolean {
  return isFirstPartyAnthropicEndpoint(config.providers, env);
}

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
  /** `OLLAMA_HOST` for the ollama CLI: the session's loopback alias when the
   * proxy binds a wildcard address, otherwise the shared origin. */
  hostOrigin: string = origin,
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
  // session by the `<session>.localhost` name it dials (see run()), or by
  // meta.ollama when that name doesn't resolve.
  if (agent === "ollama-cli" && config.providers.ollama) {
    out.OLLAMA_HOST = hostOrigin;
  }

  // Bedrock: Claude Code uses ANTHROPIC_BEDROCK_BASE_URL (not the AWS SDK env var).
  // The SDK sends requests to /model/{id}/converse-stream on this host.
  const useBedrock = env?.CLAUDE_CODE_USE_BEDROCK;
  if (useBedrock && useBedrock !== "0" && config.providers.bedrock) {
    out.ANTHROPIC_BEDROCK_BASE_URL = origin;
  }

  return out;
}

// A caller passing `--tools ""` (or `--tools=`) to claude wants a genuinely
// tool-less, non-agentic call (e.g. risk-review's single schema-validated
// review pass). ENABLE_TOOL_SEARCH defers tool *schemas*, which is meaningless
// — and was observed to still push the full tool-definition block into the
// request — when the caller has already asked for zero tools.
function explicitlyNoTools(agentArgs: string[]): boolean {
  for (let i = 0; i < agentArgs.length; i++) {
    const arg = agentArgs[i];
    if (arg === "--tools" && agentArgs[i + 1] === "") return true;
    if (arg === "--tools=") return true;
  }
  return false;
}

// Claude Code optimisations gated on the endpoint, shared with `aap route` so
// the wrapper-free path writes the same values. The launcher-level rule is
// only this one: a caller passing `--tools ""` asked for a tool-less call, so
// deferring tool schemas is meaningless there.
export function buildToolSearchEnv(
  agent: string,
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "providers">,
  agentArgs: string[] = [],
): Record<string, string> {
  if (agent !== "claude" || explicitlyNoTools(agentArgs)) return {};
  return toolSearchEnv(config.providers, env);
}

export function buildAutoModeEnv(
  agent: string,
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "providers">,
  forceNonAnthropic = false,
): Record<string, string> {
  if (agent !== "claude") return {};
  return autoModeEnv(config.providers, env, forceNonAnthropic);
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
  const parsedArgs = parseRunArgs(args, process.env);
  const { meta, cacheTtl, hooks } = parsedArgs;
  let { agent, agentArgs } = parsedArgs;
  if (!agent) {
    console.error(
      "Usage: aap run [--cache-1h] [--hooks] [--meta key=value ...] <agent> [args...]\n       aap run ollama [--model <name>] [claude|pi|opencode] [args...]",
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const sessionId = resolveSessionId(process.env);
  const origin = proxyOrigin(config.server);
  // OLLAMA_HOST cannot carry a session id in the path, so a launcher-started
  // ollama agent dials `<session>.localhost`, which resolves to the same
  // loopback address and differs only in the Host header. Fall back to the
  // shared origin (and the session pin) where that name doesn't resolve.
  const ollamaAlias = await usableOllamaAlias(sessionId);
  const ollamaHostOrigin =
    ollamaAlias === null
      ? origin
      : `http://${ollamaAlias}:${config.server.port}`;
  const cwd = process.cwd();

  // `aap run ollama`: pick model interactively and route Claude Code to the
  // built-in ollama-cloud provider.
  let ollamaPlan: Awaited<ReturnType<typeof planOllamaLaunch>> = null;
  if (agent === "ollama") {
    ollamaPlan = await planOllamaLaunch(
      agentArgs,
      process.env,
      config,
      origin,
      sessionId,
      undefined,
      ollamaHostOrigin,
    );
    if (!ollamaPlan) {
      process.exitCode = 1;
      return;
    }
    agent = ollamaPlan.agent;
    agentArgs = ollamaPlan.agentArgs;
    Object.assign(meta, ollamaPlan.meta);
  }

  const overrides =
    ollamaPlan?.env ??
    buildProviderEnv(
      agent,
      config,
      origin,
      sessionId,
      process.env,
      ollamaHostOrigin,
    );
  if (overrides.ANTHROPIC_BEDROCK_BASE_URL) {
    meta.bedrock = "1";
  }
  if (overrides.OLLAMA_HOST) {
    if (overrides.OLLAMA_HOST === origin) {
      // The OS wouldn't resolve `<session>.localhost`, so the proxy falls back
      // to pinning this session for prefix-less /api and /v1 paths.
      meta.ollama = "1";
    } else {
      meta.alias = new URL(overrides.OLLAMA_HOST).hostname;
    }
  }
  if (cacheTtl === "1h") {
    meta.cache_ttl = "1h";
    console.error(`aap: cache TTL upgraded to 1h (from 5m)`);
  }
  if (hooks) {
    meta.hooks = "1";
  }

  // Deferred tool schemas are Anthropic-only; never force them for Ollama.
  const toolSearchOverrides = ollamaPlan
    ? {}
    : buildToolSearchEnv(agent, process.env, config, agentArgs);

  const autoModeOverrides = buildAutoModeEnv(
    agent,
    process.env,
    config,
    ollamaPlan !== null,
  );

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
    ...autoModeOverrides,
  };

  console.error(`aap: session ${sessionId} (cwd ${cwd})`);
  if (agent === "claude" && process.env.ENABLE_TOOL_SEARCH === undefined) {
    if (toolSearchOverrides.ENABLE_TOOL_SEARCH) {
      console.error(
        `aap: ENABLE_TOOL_SEARCH=true (claude + first-party Anthropic endpoint)`,
      );
    } else if (explicitlyNoTools(agentArgs)) {
      console.error(
        `aap: ENABLE_TOOL_SEARCH left unset (--tools "" passed — a tool-less call)`,
      );
    } else {
      console.error(
        `aap: ENABLE_TOOL_SEARCH left unset (claude + non-Anthropic endpoint)`,
      );
    }
  }
  if (ollamaPlan?.binary === "ollama") {
    console.error(
      `aap: ollama launch ${agent} via OLLAMA_HOST=${ollamaPlan.env.OLLAMA_HOST ?? origin} (model ${ollamaPlan.model ?? "chosen by ollama"})`,
    );
  } else if (ollamaPlan) {
    console.error(
      `aap: routing claude via ollama-cloud (model ${ollamaPlan.model ?? "from args"})`,
    );
  } else if (overrides.OPENCODE_CONFIG_CONTENT) {
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

  const binary =
    ollamaPlan?.binary ?? (agent === "ollama-cli" ? "ollama" : agent);
  const child = spawn(binary, agentArgs, { stdio: "inherit", env });

  // The keep-alive ping is Anthropic-shaped and targets prompt caching, which
  // Ollama doesn't have.
  const keepAlive = env.AAP_KEEP_ALIVE === "1" && !ollamaPlan;
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

/** Bounded so a resolver that doesn't know `.localhost` can't stall a launch. */
const ALIAS_LOOKUP_TIMEOUT_MS = 300;

/**
 * `<session>.localhost` when this OS resolves it to loopback, else null.
 *
 * RFC 6761 reserves the TLD for loopback, but glibc without systemd-resolved
 * doesn't implement it. Probing the resolver the agent itself will use keeps
 * `aap run` from handing out a hostname that then fails to connect; the caller
 * falls back to the shared origin and the session pin.
 */
async function usableOllamaAlias(sessionId: string): Promise<string | null> {
  const host = ollamaAliasHostname(sessionId);
  const timedOut = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), ALIAS_LOOKUP_TIMEOUT_MS).unref();
  });
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      timedOut,
    ]);
    if (!addresses) return null;
    const loopback = addresses.some(
      ({ address }) => address.startsWith("127.") || address === "::1",
    );
    return loopback ? host : null;
  } catch {
    return null;
  }
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
