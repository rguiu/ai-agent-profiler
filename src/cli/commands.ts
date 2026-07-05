import { commandBreakdown } from "../analyze/index.js";
import { loadConfig } from "../config/index.js";
import { openStore } from "../store/index.js";

function num(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function commands(args: string[]): void {
  const json = args.includes("--json");
  const sessionIdx = args.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    let resolved: string | undefined;
    if (sessionId !== undefined) {
      resolved = store.resolveSessionId(sessionId);
      if (resolved === undefined) {
        console.error(`No session matches "${sessionId}".`);
        process.exitCode = 1;
        return;
      }
    }
    const rows = commandBreakdown(store.bashToolCalls(resolved));
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No shell commands captured (run `aap parse` first).");
      return;
    }
    console.log(
      "COMMAND".padEnd(24) +
        "CATEGORY".padEnd(10) +
        "CALLS".padEnd(8) +
        "RESULT TOKENS",
    );
    for (const r of rows) {
      console.log(
        r.command.padEnd(24) +
          r.category.padEnd(10) +
          String(r.count).padEnd(8) +
          `~${num(r.resultTokens)}`,
      );
    }
  } finally {
    store.close();
  }
}
