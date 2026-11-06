import type { ProviderConfig } from "../config/index.js";
import { claudeEnvOptimizations } from "./claude-env.js";
import { shellProfilePath } from "./shell-profile.js";

/**
 * Client configuration for transparent routing.
 *
 * The proxy accepts a constant base URL per provider (`/<provider>/…`); the
 * session comes from a request header (see proxy/attribution.ts). That means an
 * agent can be pointed at the proxy by a config file it already reads, with no
 * launcher and no wrapper — these are the edits `aap route` applies.
 *
 * Everything here is a pure function over the *existing* config object so the
 * merge is testable and never clobbers unrelated keys.
 */

export type ClientId = "claude" | "opencode" | "pi" | "ollama";

export const CLIENT_IDS: readonly ClientId[] = [
  "claude",
  "opencode",
  "pi",
  "ollama",
];

/** Providers whose base URL an agent can be pointed at directly. */
type Providers = Readonly<Record<string, ProviderConfig>>;

export interface ClientPatchOptions {
  /** Ambient environment the routing was chosen in. `aap run` reads it to gate
   * the Claude Code optimisations (Bedrock/Vertex selected, explicit opt-outs);
   * `aap route` has no child process, so it passes the user's shell env and the
   * optimisations land in the settings file instead. */
  env?: NodeJS.ProcessEnv;
  /** `--cache-1h`: write Claude Code's native one-hour prompt cache TTL. */
  cacheTtl?: "1h";
}

/** Base URL an agent should use for a provider. Mirrors `buildProviderEnv`:
 * Claude Code appends `/v1/messages` itself, OpenAI-compatible clients do not
 * (opencode and pi take the API path as part of the base URL). */
export function providerBaseUrl(
  origin: string,
  name: string,
  cfg: ProviderConfig,
  includeApiPath: boolean,
): string {
  return includeApiPath
    ? `${origin}/${name}${cfg.apiPath ?? "/v1"}`
    : `${origin}/${name}`;
}

/**
 * Claude Code: `~/.claude/settings.json` `env` block. User scope (not project)
 * so it applies to terminal, IDE and desktop sessions without a trust prompt.
 *
 * The `env` block is also where the launcher-only optimisations go, because a
 * settings value overwrites the same variable exported in the shell — so we
 * only write the ones the ambient env hasn't already decided.
 */
export function claudeSettingsPatch(
  origin: string,
  providers: Providers,
  opts: ClientPatchOptions = {},
): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (providers.anthropic) {
    env.ANTHROPIC_BASE_URL = providerBaseUrl(
      origin,
      "anthropic",
      providers.anthropic,
      false,
    );
  }
  if (providers.openai) {
    env.OPENAI_BASE_URL = providerBaseUrl(
      origin,
      "openai",
      providers.openai,
      false,
    );
  }
  // Claude Code reads ANTHROPIC_BEDROCK_BASE_URL only with
  // CLAUDE_CODE_USE_BEDROCK=1, so both routes can coexist in one file.
  if (providers.bedrock) {
    env.ANTHROPIC_BEDROCK_BASE_URL = origin;
  }
  // ENABLE_TOOL_SEARCH (deferred tool schemas) and
  // CLAUDE_CODE_AUTO_MODE_SERVER (off first-party Anthropic) — the same gating
  // `aap run` applies, so demoting the launcher doesn't drop them.
  Object.assign(env, claudeEnvOptimizations(providers, opts.env ?? {}));

  const patch: Record<string, unknown> = {};
  if (Object.keys(env).length > 0) patch.env = env;
  // Claude Code ≥ 2.1.242 has a first-class TTL key. Setting it here beats the
  // proxy rewrite `aap run --cache-1h` uses, which needs per-session meta the
  // proxy can't have when nothing wraps the launch. Both keys so subagents,
  // compaction and title requests match the main conversation.
  if (opts.cacheTtl === "1h") {
    patch.promptCacheTtl = "1h";
    patch.subagentPromptCacheTtl = "1h";
  }
  return patch;
}

/** opencode: `~/.config/opencode/opencode.json` — one baseURL per provider. */
export function opencodeConfigPatch(
  origin: string,
  providers: Providers,
): Record<string, unknown> {
  const provider: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(providers)) {
    provider[name] = {
      options: { baseURL: providerBaseUrl(origin, name, cfg, true) },
    };
  }
  return Object.keys(provider).length > 0 ? { provider } : {};
}

/** Provider ids pi resolves on its own. Any other id would need `api`/`models`,
 * which is not what routing an existing setup should do. */
const PI_PROVIDERS: readonly string[] = ["anthropic", "openai", "ollama"];

/** pi: `~/.pi/agent/models.json` — overriding only `baseUrl` keeps pi's bundled
 * models and authentication for that provider. */
export function piModelsPatch(
  origin: string,
  providers: Providers,
): Record<string, unknown> {
  const routeable: Record<string, unknown> = {};
  for (const name of PI_PROVIDERS) {
    const cfg = providers[name];
    if (!cfg) continue;
    routeable[name] = {
      baseUrl: providerBaseUrl(origin, name, cfg, true),
    };
  }
  return Object.keys(routeable).length > 0 ? { providers: routeable } : {};
}

/** Shallow-merge `patch` into `base`, recursing into plain objects. Arrays and
 * scalars from the patch replace the existing value. */
export function mergeConfig(
  base: unknown,
  patch: unknown,
): Record<string, unknown> {
  if (!isRecord(base)) return { ...(patch as Record<string, unknown>) };
  if (!isRecord(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] =
      isRecord(existing) && isRecord(value)
        ? mergeConfig(existing, value)
        : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute path of a client's config file. */
export function clientConfigPath(client: ClientId, home: string): string {
  switch (client) {
    case "claude":
      return `${home}/.claude/settings.json`;
    case "opencode":
      return `${home}/.config/opencode/opencode.json`;
    case "pi":
      return `${home}/.pi/agent/models.json`;
    case "ollama":
      // Not a config file: ollama's launcher rewrites the agent's provider from
      // OLLAMA_HOST, so `aap route` owns a scoped function in the login profile.
      return shellProfilePath(home) ?? `${home}/.zshrc`;
  }
}

export function clientPatch(
  client: ClientId,
  origin: string,
  providers: Providers,
  opts: ClientPatchOptions = {},
): Record<string, unknown> {
  switch (client) {
    case "claude":
      return claudeSettingsPatch(origin, providers, opts);
    case "opencode":
      return opencodeConfigPatch(origin, providers);
    case "pi":
      return piModelsPatch(origin, providers);
    case "ollama":
      // OLLAMA_HOST carries no path, and the daemon is not a config file —
      // `aap route --write ollama` prints the export instead of editing .zshrc.
      return {};
  }
}

/** Does this config already point at `origin`? Used by the status report. */
export function isRouted(
  client: ClientId,
  config: unknown,
  origin: string,
): boolean {
  const needle = origin;
  const hits: string[] = [];
  collectStrings(config, hits);
  return hits.some((value) => value.includes(needle));
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, out, depth + 1);
    }
  }
}
