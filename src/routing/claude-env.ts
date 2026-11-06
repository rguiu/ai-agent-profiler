import type { ProviderConfig } from "../config/index.js";

/**
 * Claude Code environment optimisations, shared by the two ways of routing it.
 *
 * `aap run` sets these in the child's environment; `aap route` has no child, so
 * it writes the same values into the `env` block of `~/.claude/settings.json`
 * (see routing/route-config.ts). Keeping the gating in one place is what stops
 * the two paths from drifting: a rule that only holds when aap launches claude
 * is a rule that silently disappears once the proxy is transparent.
 */

/** Provider map, as stored in `Config.providers`. */
type Providers = Readonly<Record<string, ProviderConfig>>;

function envFlag(value: string | undefined): boolean {
  return Boolean(value) && value !== "0";
}

/** True when Claude Code will be talking to a first-party Anthropic endpoint.
 * Bedrock is a distinct API (AWS), not the Anthropic messages endpoint, so it
 * is not first-party here. Otherwise we trust the `anthropic` provider's
 * upstream host: only api.anthropic.com (or an *.anthropic.com enterprise
 * endpoint) counts. A third-party gateway serving a real Anthropic model is
 * deliberately left "not first-party" — the safe default is to not force true. */
export function isFirstPartyAnthropic(
  config: Providers,
  env: NodeJS.ProcessEnv,
): boolean {
  const useBedrock =
    env.CLAUDE_CODE_USE_BEDROCK && env.CLAUDE_CODE_USE_BEDROCK !== "0";
  if (useBedrock) return false;

  const upstream = config.anthropic?.upstream;
  if (!upstream) return false;

  try {
    const host = new URL(upstream).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

// Without `[providers.anthropic]` aap doesn't set ANTHROPIC_BASE_URL, so
// Claude Code keeps its own (first-party) endpoint unless a cloud backend is
// selected in the env.
export function routesClaudeOffAnthropic(
  config: Providers,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    envFlag(env.CLAUDE_CODE_USE_BEDROCK) ||
    envFlag(env.CLAUDE_CODE_USE_VERTEX)
  ) {
    return true;
  }
  if (!config.anthropic) return false;
  return !isFirstPartyAnthropic(config, env);
}

/**
 * `ENABLE_TOOL_SEARCH=true` when it is both safe and wanted.
 *
 * Claude Code caches its tool definitions per ANTHROPIC_BASE_URL; routing it
 * through the proxy changes that URL and invalidates the cache, so every
 * request resends the full tool list. ENABLE_TOOL_SEARCH defers tool schemas
 * instead, keeping the cache valid. Only for a first-party Anthropic endpoint:
 * deferred custom tools are Anthropic-only (upstream #89211), and forcing it
 * against DeepSeek/Bedrock/Ollama/a gateway yields a 400.
 */
export function toolSearchEnv(
  config: Providers,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (env.ENABLE_TOOL_SEARCH !== undefined) return {};
  return isFirstPartyAnthropic(config, env)
    ? { ENABLE_TOOL_SEARCH: "true" }
    : {};
}

/**
 * `CLAUDE_CODE_AUTO_MODE_SERVER=0` off first-party Anthropic.
 *
 * Auto mode's classifier checks run server-side on Anthropic's API. Any other
 * backend (Ollama, DeepSeek, Bedrock, Vertex, a gateway) can't perform them, so
 * Claude Code nags about ineligibility on every session. Opt out up front there.
 */
export function autoModeEnv(
  config: Providers,
  env: NodeJS.ProcessEnv,
  forceNonAnthropic = false,
): Record<string, string> {
  if (env.CLAUDE_CODE_AUTO_MODE_SERVER !== undefined) return {};
  return forceNonAnthropic || routesClaudeOffAnthropic(config, env)
    ? { CLAUDE_CODE_AUTO_MODE_SERVER: "0" }
    : {};
}

/** Every optimisation above, as one env block. */
export function claudeEnvOptimizations(
  config: Providers,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return { ...toolSearchEnv(config, env), ...autoModeEnv(config, env) };
}
