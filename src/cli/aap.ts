#!/usr/bin/env node
import { ConfigError, loadConfig } from "../config/index.js";
import { analyzeClaude } from "./analyze-claude.js";
import { commands } from "./commands.js";
import { compareSessions } from "./compare.js";
import { exportSession } from "./export.js";
import { hook } from "./hook.js";
import { idleGaps } from "./idle-gaps.js";
import { install } from "./install.js";
import { intro } from "./intro.js";
import { mcp } from "./mcp.js";
import { parse } from "./parse.js";
import { run } from "./run.js";
import { serve } from "./serve.js";
import { sessions } from "./sessions.js";
import { tag } from "./tag.js";

function printHelp(): void {
  console.log(`aap — AI Agent Profiler

Usage:
  aap install          Set up ~/.aap/config.toml from the example config
  aap serve            Start the profiler proxy
  aap run <agent>      Launch an agent through the profiler
  aap parse [--all]    Derive metrics from captured traces
  aap sessions         List captured sessions (rm <id> to delete)
  aap commands         Break down shell commands by token cost
  aap tag <id> k=v     Tag a session with metadata (e.g. verify=pass)
  aap export <id>      Export a session report (Markdown; --json for JSON)
  aap compare <ids...> Compare sessions side by side (--json for JSON)
  aap analyze-claude <id>  Inspect a Claude Code transcript (read-only; savings)
  aap hook install     Install tool-output filtering wrappers
  aap idle-gaps [--json] Bucket request idle gaps to assess cache TTL upgrade viability
  aap intro <agent>    Introspect captured sessions through an agent with MCP tools
  aap mcp              Start an MCP server for agent introspection
  aap config           Print the resolved configuration
  aap help             Show this help
`);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case "serve":
      serve(argv.slice(1));
      return;
    case "run":
      await run(argv.slice(1));
      return;
    case "parse":
      await parse(argv.slice(1));
      return;
    case "sessions":
      sessions(argv.slice(1));
      return;
    case "commands":
      commands(argv.slice(1));
      return;
    case "tag":
      tag(argv.slice(1));
      return;
    case "export":
      exportSession(argv.slice(1));
      return;
    case "compare":
      compareSessions(argv.slice(1));
      return;
    case "analyze-claude":
      analyzeClaude(argv.slice(1));
      return;
    case "install":
      install();
      return;
    case "hook":
      hook(argv.slice(1));
      return;
    case "idle-gaps":
      idleGaps(argv.slice(1));
      return;
    case "intro":
      await intro(argv.slice(1));
      return;
    case "mcp":
      await mcp();
      return;
    case "config":
      console.log(JSON.stringify(loadConfig(), null, 2));
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
