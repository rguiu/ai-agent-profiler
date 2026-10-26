import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  OLLAMA_CLOUD_PROVIDER,
  OLLAMA_CLOUD_UPSTREAM,
  type Config,
} from "../config/index.js";

export interface OllamaArgs {
  model?: string;
  agent?: string;
  agentArgs: string[];
}

export interface OllamaLaunchPlan {
  agent: string;
  // Executable to spawn; defaults to the agent itself. The `ollama launch`
  // agents run through the `ollama` binary.
  binary?: string;
  agentArgs: string[];
  env: Record<string, string>;
  meta: Record<string, string>;
  model: string | undefined;
}

// `aap run ollama [--model M] [agent] [agent args...]`. Everything after the
// agent is passed through untouched; a `--model` there also counts as chosen.
export function parseOllamaArgs(args: string[]): OllamaArgs {
  let model: string | undefined;
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--model" || arg === "-m") {
      model = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      i += 1;
    } else {
      break;
    }
  }
  const agent = args[i];
  const agentArgs = agent === undefined ? [] : args.slice(i + 1);
  return { model: model || undefined, agent, agentArgs };
}

function agentArgsSetModel(agentArgs: string[]): boolean {
  return agentArgs.some(
    (a) => a === "--model" || a === "-m" || a.startsWith("--model="),
  );
}

// Agents started through the real `ollama launch <agent>`. Ollama configures
// them to talk to the daemon at OLLAMA_HOST, which we point at the proxy.
export const OLLAMA_LAUNCH_AGENTS = ["pi", "opencode"] as const;

function isLaunchAgent(agent: string): boolean {
  return (OLLAMA_LAUNCH_AGENTS as readonly string[]).includes(agent);
}

// `ollama launch <agent> [--model M] [-- agent args...]`
export function buildOllamaLaunchArgs(
  agent: string,
  model: string | undefined,
  agentArgs: string[],
): string[] {
  // opencode 2.x attaches to a shared background service that keeps the
  // config and env of whoever started it, so this launch's model and routing
  // would be ignored. A private server picks them up.
  const args =
    agent === "opencode" && !agentArgs.includes("--standalone")
      ? ["--standalone", ...agentArgs]
      : agentArgs;
  const out = ["launch", agent];
  if (model) out.push("--model", model);
  if (args.length > 0) out.push("--", ...args);
  return out;
}

export function buildOllamaClaudeEnv(opts: {
  origin: string;
  sessionId: string;
  apiKey: string;
  model?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${opts.origin}/${opts.sessionId}/${OLLAMA_CLOUD_PROVIDER}`,
    ANTHROPIC_AUTH_TOKEN: opts.apiKey,
    ANTHROPIC_API_KEY: "",
  };
  if (opts.model) {
    // Claude Code also sends opus/sonnet/haiku-tier requests (e.g. background
    // summaries); pin every tier to the chosen model so none reach Ollama
    // under a Claude model name.
    env.ANTHROPIC_MODEL = opts.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = opts.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = opts.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.model;
  }
  return env;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// Lists models the account can use. Best effort: any failure returns [] and
// the caller falls back to free-text entry.
export async function fetchOllamaModels(
  upstream: string,
  apiKey: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 5000,
): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${upstream.replace(/\/+$/, "")}/api/tags`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string")
      .sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function resolveModelChoice(
  answer: string,
  models: string[],
): string | undefined {
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const picked = models[Number(trimmed) - 1];
    if (picked) return picked;
  }
  return trimmed;
}

async function promptSecret(question: string): Promise<string> {
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({
    input: process.stdin,
    output: muted,
    terminal: true,
  });
  process.stderr.write(question);
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Resolves agent, API key and model (prompting on a TTY), and returns the
// launch environment. Returns null after printing an error when it can't.
export async function planOllamaLaunch(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "providers">,
  origin: string,
  sessionId: string,
  interactive: boolean = Boolean(process.stdin.isTTY && process.stderr.isTTY),
): Promise<OllamaLaunchPlan | null> {
  const parsed = parseOllamaArgs(args);
  const agent = parsed.agent ?? "claude";
  if (isLaunchAgent(agent)) {
    return planOllamaNativeLaunch(
      agent,
      parsed,
      env,
      config,
      origin,
      interactive,
    );
  }
  if (agent !== "claude") {
    console.error(
      `aap: "aap run ollama" supports claude, ${OLLAMA_LAUNCH_AGENTS.join(", ")} (got "${agent}")`,
    );
    return null;
  }

  let apiKey = env.OLLAMA_API_KEY ?? "";
  if (!apiKey && interactive) {
    apiKey = await promptSecret(
      "Ollama API key (OLLAMA_API_KEY, not stored): ",
    );
  }
  if (!apiKey) {
    console.error(
      "aap: OLLAMA_API_KEY is not set. Export it in your shell, e.g. in ~/.zshrc.",
    );
    return null;
  }

  let model = parsed.model;
  const modelInArgs = agentArgsSetModel(parsed.agentArgs);
  if (!model && !modelInArgs) {
    if (!interactive) {
      console.error(
        "aap: no model given. Pass --model <name> (prompts are disabled without a TTY).",
      );
      return null;
    }
    const upstream =
      config.providers[OLLAMA_CLOUD_PROVIDER]?.upstream ??
      OLLAMA_CLOUD_UPSTREAM;
    const models = await fetchOllamaModels(upstream, apiKey);
    if (models.length > 0) {
      console.error("Models:");
      models.forEach((m, i) => console.error(`  ${i + 1}) ${m}`));
    } else {
      console.error("(could not list models; type a name)");
    }
    model = resolveModelChoice(await promptLine("Model: "), models);
    if (!model) {
      console.error("aap: no model selected");
      return null;
    }
  }

  const meta: Record<string, string> = { provider: OLLAMA_CLOUD_PROVIDER };
  if (model) meta.model = model;
  return {
    agent,
    agentArgs: parsed.agentArgs,
    env: buildOllamaClaudeEnv({ origin, sessionId, apiKey, model }),
    meta,
    model,
  };
}

// Cloud models are addressed through the daemon with a `cloud` marker:
// `glm-5.3-flash` -> `glm-5.3-flash:cloud`, `gpt-oss:120b` -> `gpt-oss:120b-cloud`.
export function toDaemonCloudName(name: string): string {
  if (/[:-]cloud$/.test(name)) return name;
  return name.includes(":") ? `${name}-cloud` : `${name}:cloud`;
}

// Local daemon models plus (when OLLAMA_API_KEY is set) the account's cloud
// models, so the list matches what the claude path shows.
async function listLaunchModels(
  daemonUpstream: string,
  config: Pick<Config, "providers">,
  apiKey: string,
): Promise<string[]> {
  const cloudUpstream =
    config.providers[OLLAMA_CLOUD_PROVIDER]?.upstream ?? OLLAMA_CLOUD_UPSTREAM;
  const [local, cloud] = await Promise.all([
    fetchOllamaModels(daemonUpstream, ""),
    apiKey ? fetchOllamaModels(cloudUpstream, apiKey) : Promise.resolve([]),
  ]);
  return [...new Set([...local, ...cloud.map(toDaemonCloudName)])].sort();
}

// pi / opencode: run `ollama launch <agent>` with OLLAMA_HOST pointed at the
// proxy, which relays /api/* to the local daemon (`[providers.ollama]`). The
// daemon handles local and `:cloud` models, so no OLLAMA_API_KEY is needed.
async function planOllamaNativeLaunch(
  agent: string,
  parsed: OllamaArgs,
  env: NodeJS.ProcessEnv,
  config: Pick<Config, "providers">,
  origin: string,
  interactive: boolean,
): Promise<OllamaLaunchPlan | null> {
  const daemon = config.providers.ollama;
  if (!daemon) {
    console.error(
      `aap: "aap run ollama ${agent}" needs [providers.ollama] in your config (upstream = your local daemon, e.g. http://127.0.0.1:11434). See the README's Ollama section.`,
    );
    return null;
  }

  // A `--model` after the agent goes to the agent untouched, as on the
  // claude path.
  let model = parsed.model;
  const modelInArgs = agentArgsSetModel(parsed.agentArgs);
  if (!model && !modelInArgs && !interactive) {
    // `ollama launch` would ask for a model on a stdin that isn't a TTY.
    console.error(
      "aap: no model given. Pass --model <name> (prompts are disabled without a TTY).",
    );
    return null;
  }
  if (!model && !modelInArgs) {
    // Same first question as the claude path. Only used to list cloud models
    // here (the daemon authenticates for the launch itself); blank skips them.
    let apiKey = env.OLLAMA_API_KEY ?? "";
    if (!apiKey) {
      apiKey = await promptSecret(
        "Ollama API key (OLLAMA_API_KEY, not stored; blank = local models only): ",
      );
    }
    const models = await listLaunchModels(daemon.upstream, config, apiKey);
    if (models.length > 0) {
      console.error("Models:");
      models.forEach((m, i) => console.error(`  ${i + 1}) ${m}`));
    }
    // Blank answer leaves the choice to `ollama launch` itself.
    model = resolveModelChoice(
      await promptLine("Model (blank = let ollama ask): "),
      models,
    );
  }

  const meta: Record<string, string> = {
    provider: "ollama",
    launcher: "ollama-launch",
  };
  if (model) meta.model = model;
  return {
    agent,
    binary: "ollama",
    agentArgs: buildOllamaLaunchArgs(agent, model, parsed.agentArgs),
    env: { OLLAMA_HOST: origin },
    meta,
    model,
  };
}
