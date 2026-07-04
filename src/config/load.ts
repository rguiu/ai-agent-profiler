import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { configSchema, type Config } from "./schema.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.AAP_CONFIG ?? "config.toml";
}

export function loadConfig(
  path: string = resolveConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): Config {
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
