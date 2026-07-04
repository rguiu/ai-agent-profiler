import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import type { SessionInfo } from "../session/index.js";

const PROVIDER_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
};

export async function run(args: string[]): Promise<void> {
  const agent = args[0];
  const agentArgs = args.slice(1);
  if (!agent) {
    console.error("Usage: aap run <agent> [args...]");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const sessionId = randomUUID();
  const host = normalizeHost(config.server.host);
  const origin = `http://${host}:${config.server.port}`;
  const cwd = process.cwd();

  const session: SessionInfo = {
    id: sessionId,
    client: agent,
    cwd,
    repo: detectRepo(cwd),
    startedAt: new Date().toISOString(),
  };
  await registerSession(origin, session);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const provider of Object.keys(config.providers)) {
    const varName = PROVIDER_ENV[provider];
    if (!varName) continue;
    const url = `${origin}/${sessionId}/${provider}`;
    env[varName] = url;
    console.error(`aap: ${varName}=${url}`);
  }
  console.error(`aap: session ${sessionId} (cwd ${cwd})`);

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
