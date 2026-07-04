#!/usr/bin/env node
import { ConfigError, loadConfig } from "../config/index.js";

function printHelp(): void {
  console.log(`aap — AI Agent Profiler

Usage:
  aap serve            Start the profiler proxy (planned: M1)
  aap run <agent>      Launch an agent through the profiler (planned: M1)
  aap config           Print the resolved configuration
  aap help             Show this help
`);
}

function main(argv: string[]): void {
  const command = argv[0];
  switch (command) {
    case "serve":
    case "run":
      console.error(
        `"aap ${command}" is not implemented yet (planned for M1).`,
      );
      process.exitCode = 1;
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

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
