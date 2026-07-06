import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "../config/index.js";
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

  // Bedrock: Claude Code uses ANTHROPIC_BEDROCK_BASE_URL (not the AWS SDK env var).
  // The SDK sends requests to /model/{id}/converse-stream on this host.
  const useBedrock = env?.CLAUDE_CODE_USE_BEDROCK;
  if (useBedrock && useBedrock !== "0" && config.providers.bedrock) {
    out.ANTHROPIC_BEDROCK_BASE_URL = origin;
  }

  return out;
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
): { meta: Record<string, string>; agent?: string; agentArgs: string[] } {
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("AAP_META_") && value) {
      meta[key.slice("AAP_META_".length).toLowerCase()] = value;
    }
  }
  if (env.ARMADA_NODE_NAME) meta.armada_node = env.ARMADA_NODE_NAME;

  let i = 0;
  while (i < args.length && args[i] === "--meta") {
    const pair = args[i + 1];
    if (pair !== undefined) {
      const eq = pair.indexOf("=");
      if (eq > 0) meta[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    i += 2;
  }
  return { meta, agent: args[i], agentArgs: args.slice(i + 1) };
}

export async function run(args: string[]): Promise<void> {
  const { meta, agent, agentArgs } = parseRunArgs(args, process.env);
  if (!agent) {
    console.error("Usage: aap run [--meta key=value ...] <agent> [args...]");
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

  const session: SessionInfo = {
    id: sessionId,
    client: agent,
    cwd,
    repo: detectRepo(cwd),
    startedAt: new Date().toISOString(),
    meta: Object.keys(meta).length > 0 ? meta : null,
  };
  await registerSession(origin, session);
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };

  console.error(`aap: session ${sessionId} (cwd ${cwd})`);
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

  const child = spawn(agent, agentArgs, { stdio: "inherit", env });
  child.on("error", (err) => {
    console.error(`aap: failed to launch "${agent}": ${err.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function normalizeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

async function registerSession(
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
