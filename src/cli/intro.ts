import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { buildProviderEnv, registerSession } from "./run.js";

const INTRO_CLAUSE = `
You are an AI agent operating inside the AI Agent Profiler (aap) introspection environment.
You have MCP tools that give you read-only access to the profiler's SQLite database — every
session, request, tool call, token count, and cost is queryable.

## Capabilities
- **list_sessions** — list all captured sessions with token/cost summary
- **get_session** — full detail for one session (requests, analysis, recommendations)
- **get_request** — one request's detail including trace events and tool calls
- **recommend** — actionable optimization findings for a session
- **stats** — global aggregate (sessions, requests, total tokens, total cost)
- **top_tools** — tool usage breakdown across all sessions
- **command_breakdown** — shell commands with call counts and result tokens
- **compare** — side-by-side session comparison
- **search_requests** — search requests by model, tool, or path patterns
- **raw_sql** — read-only SQL queries on sessions, requests, metrics, tool_calls
- **idle_gaps** — request idle-gap distribution (<5m, 5m-1h, >1h)
- **projects** — all projects (cwd/repo) with session count, total cost, tokens
- **session_timeline** — sessions grouped by day with cost trend
- **session_lengths** — per-session stats sorted by cost/size

## Your job
1. Ask the user what scope to analyze (how many days back, all sessions, a specific project).
2. Query the MCP tools to gather data.
3. Produce a structured analysis saved as \`report.json\` in your working directory.
4. The report MUST include these keys:
   - \`scope\`: what was analyzed (e.g. "last 3 days", "project /home/user/repo")
   - \`summary\`: 2-3 sentence plain-English summary
   - \`cost_profile\`: { total_cost, avg_cost_per_session, most_expensive_session_id }
   - \`tool_insights\`: top 5 tools by usage, any amplification issues
   - \`recommendations\`: list of specific, actionable suggestions (from the \`recommend\` MCP tool or your analysis)
   - \`graphs\`: structured data the UI can render as charts (session_timeline entries, project breakdown, etc.)
5. You may ask the user follow-up questions before writing the report.
6. After writing report.json, you may append useful patterns or findings to \`CLAUDE.md\` in the
   parent \`introspections\` folder so future introspection sessions improve.
`.trim();

export function introspectionsDir(home: string = homedir()): string {
  return join(home, ".aap", "introspections");
}

export function ensureClaudeMd(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "CLAUDE.md");
  if (!existsSync(path)) {
    writeFileSync(path, INTRO_CLAUSE);
  }
}

export async function intro(args: string[]): Promise<void> {
  const agent = args[0];
  if (!agent) {
    console.error("Usage: aap intro <agent>  (e.g. aap intro opencode)");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const home = homedir();
  const introDir = introspectionsDir(home);
  ensureClaudeMd(introDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(introDir, timestamp);
  mkdirSync(runDir, { recursive: true });

  const claudeMdSrc = join(introDir, "CLAUDE.md");
  if (existsSync(claudeMdSrc)) {
    writeFileSync(join(runDir, "CLAUDE.md"), readFileSync(claudeMdSrc));
  }

  process.chdir(runDir);

  const sessionId = `intro-${timestamp}`;
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  const origin = `http://${host}:${config.server.port}`;
  const cwd = process.cwd();

  const providerEnv = buildProviderEnv(agent, config, origin, sessionId);
  const baseConfig = JSON.parse(providerEnv.OPENCODE_CONFIG_CONTENT ?? "{}");

  const aapScript = process.argv[1];
  const aapCommand = aapScript?.endsWith(".ts")
    ? { command: "npx", args: ["tsx", aapScript, "mcp"] }
    : { command: process.execPath, args: [aapScript, "mcp"] };

  const opencodeConfig = {
    ...baseConfig,
    mcp: {
      aap: {
        ...aapCommand,
        type: "local",
        enabled: true,
      },
    },
  };

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
    AAP_SESSION_ID: sessionId,
  };

  const session = {
    id: sessionId,
    client: agent,
    cwd,
    repo: null,
    startedAt: new Date().toISOString(),
    meta: { kind: "introspection" },
  };

  try {
    await registerSession(origin, session);
  } catch {
    console.error("aap intro: proxy not running. Start aap serve first.");
    process.exitCode = 1;
    return;
  }

  console.error(`aap intro: session ${sessionId} (dir ${runDir})`);
  console.error(`aap intro: opencode connected to aap MCP tools`);
  console.error(
    `aap intro: ask me what to analyze — I can see all your sessions.\n`,
  );

  const child = spawn(agent, args.slice(1), { stdio: "inherit", env });

  child.on("exit", (code) => {
    console.error(`\naap intro: session ended (exit ${code})`);
    console.error(`aap intro: report at ${join(runDir, "report.json")}`);
  });
}
