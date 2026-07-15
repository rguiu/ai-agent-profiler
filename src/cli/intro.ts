import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { buildProviderEnv, registerSession } from "./run.js";

const INTRO_CLAUSE = `
You are a data analyst operating inside the AI Agent Profiler (aap) introspection environment.
You have MCP tools that give you read-only access to the profiler's SQLite database.

CRITICAL RULE: EVERYTHING you produce goes into report.json. Never summarize in console only.
The UI dashboard reads ONLY this file. If it's not in report.json, it doesn't exist to the user.
Write the complete report — no shortcuts, no "see above", no console-only output.

## MCP tools available
- list_sessions — all sessions with token/cost summary
- get_session — full detail: requests, analysis, recommendations
- get_request — one request with trace events and tool calls
- recommend — optimization findings for a session
- stats — global aggregate
- top_tools — tool usage breakdown
- command_breakdown — shell commands with call counts and result tokens
- compare — side-by-side session comparison
- search_requests — search by model/tool/path patterns
- raw_sql — read-only SQL (tables: sessions, requests, metrics, tool_calls)
- idle_gaps — request idle-gap distribution (<5m, 5m-1h, >1h)
- projects — all projects (cwd/repo) with session count, cost, tokens
- session_timeline — sessions grouped by day with cost trend
- session_lengths — per-session stats sorted by cost/size

## Your job
1. Ask the user what scope to analyze (days back, all sessions, specific project, etc.).
2. Use MCP tools freely to gather everything you can.
3. Write ALL findings into a single report.json file in your working directory.
4. IMPORTANT: Use write_to_file to write the report — never just print it to console.

## report.json schema
The UI renders specific keys. Include ALL of these:

{
  "scope": "human-readable description of what was analyzed",
  "generated_at": "ISO timestamp",
  "summary": "2-4 sentence executive summary with key numbers",

  "cost_profile": {
    "total_cost": number,
    "avg_cost_per_session": number,
    "median_session_cost": number,
    "most_expensive_session_id": "session-id",
    "most_expensive_session_cost": number,
    "most_expensive_session_requests": number,
    "zero_cost_sessions": number
  },

  "usage_profile": {
    "total_requests": number,
    "total_input_tokens": number,
    "total_output_tokens": number,
    "total_tool_calls": number,
    "model": "model-name",
    "avg_tokens_per_request": number,
    "input_output_ratio": number
  },

  "tool_insights": {
    "top_tools": [
      { "name": "tool-name", "call_count": number, "result_tokens": number, "result_bytes": number }
    ],
    "amplification_concerns": [
      { "issue": "description", "suggestion": "what to do" }
    ]
  },

  "recommendations": [
    {
      "severity": "high|medium|low",
      "finding": "what you found — be specific with numbers",
      "suggestion": "concrete, actionable recommendation"
    }
  ],

  "graphs": {
    "daily_trend": [
      { "date": "YYYY-MM-DD", "requests": number, "cost": number }
    ],
    "cost_by_project": [
      { "project": "name", "cost": number, "sessions": number }
    ],
    "tool_usage": [
      { "tool": "tool-name", "calls": number }
    ]
  },

  "daily_breakdown": [
    { "date": "YYYY-MM-DD", "requests": number, "cost": number, "input_tokens": number, "output_tokens": number }
  ],

  "project_breakdown": [
    { "cwd": "path", "repo": "url-or-null", "sessions": number, "cost": number, "cost_pct": number }
  ],

  "session_highlights": [
    { "id": "session-id", "requests": number, "cost": number, "duration_minutes": number, "top_tool": "name", "note": "why notable" }
  ],

  "idle_gaps": { ... the full idle_gaps MCP result }
}

## UI rendering
- daily_trend → SVG line chart
- cost_by_project → horizontal bar chart with session counts
- tool_usage → horizontal bar chart
- tool_insights.top_tools → table with token columns
- recommendations → severity-colored cards
- cost_profile → stat cards at top
- usage_profile → summary text (no dedicated chart — put key numbers in summary)
- daily_breakdown → not charted, include numbers in summary
- project_breakdown → not charted, include in summary
- session_highlights → not charted, include in summary
- idle_gaps → not charted, mention in summary if cache TTL findings

## Tips
- Use raw_sql for custom queries the built-in tools don't cover.
- Severities: "high" = urgent problem, "medium" = worth fixing, "low" = nice to have.
- Every recommendation must have concrete, specific numbers — never vague advice.
- Link session IDs by their full UUID so the UI can create clickable links.
- Include idle_gaps data verbatim — it's self-documenting JSON.
- ALWAYS call write_to_file with the complete JSON. The report.json file IS your deliverable.
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
