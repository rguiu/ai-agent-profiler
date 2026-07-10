import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { configSchema, type Config } from "./schema.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function configCandidates(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string[] {
  if (env.AAP_CONFIG) return [env.AAP_CONFIG];
  return [join(home, ".aap", "config.toml"), join(cwd, "config.toml")];
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): string | null {
  const candidates = configCandidates(env, cwd, home);
  if (env.AAP_CONFIG) return candidates[0] ?? null;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function loadConfig(
  pathArg?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  home: string = homedir(),
): Config {
  const path = pathArg ?? resolveConfigPath(env, cwd, home);
  if (path === null) {
    const looked = configCandidates(env, cwd, home)
      .map((candidate) => `  - ${candidate}`)
      .join("\n");
    throw new ConfigError(
      `No config file found. Looked in:\n${looked}\n\nRun ./install.sh (creates ~/.aap/config.toml), or copy config.example.toml to ~/.aap/config.toml, or set AAP_CONFIG.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(
      `Cannot read config file at "${path}": ${(err as Error).message}`,
    );
  }

  let data: unknown;
  try {
    data = parseToml(raw);
  } catch (err) {
    throw new ConfigError(
      `Invalid TOML in "${path}": ${(err as Error).message}`,
    );
  }

  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid config in "${path}":\n${formatIssues(parsed.error)}`,
    );
  }

  return applyEnvOverrides(parsed.data, env);
}

function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv): Config {
  const portOverride = env.AAP_PORT;
  if (portOverride !== undefined) {
    const port = Number(portOverride);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ConfigError(
        `AAP_PORT must be a positive integer, got "${portOverride}"`,
      );
    }
    config.server.port = port;
  }
  return config;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
