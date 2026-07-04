#!/usr/bin/env node
import { ConfigError, loadConfig } from "../config/index.js";
import { parse } from "./parse.js";
import { run } from "./run.js";
import { serve } from "./serve.js";

function printHelp(): void {
  console.log(`aap — AI Agent Profiler

Usage:
  aap serve            Start the profiler proxy
  aap run <agent>      Launch an agent through the profiler
  aap parse [--all]    Derive metrics from captured traces
  aap config           Print the resolved configuration
  aap help             Show this help
`);
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case "serve":
      serve();
      return;
    case "run":
      await run(argv.slice(1));
      return;
    case "parse":
      parse(argv.slice(1));
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
