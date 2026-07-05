import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { openStore } from "../store/index.js";

function num(value: number | null | undefined): string {
  return Math.round(value ?? 0)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

export function sessions(args: string[]): void {
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    if (args[0] === "rm") {
      const ids = args.slice(1).filter((a) => !a.startsWith("--"));
      if (ids.length === 0) {
        console.error("Usage: aap sessions rm <session-id> [...]");
        process.exitCode = 1;
        return;
      }
      for (const idOrPrefix of ids) {
        const id = store.resolveSessionId(idOrPrefix);
        if (!id) {
          console.error(
            `session "${idOrPrefix}" not found (or ambiguous prefix)`,
          );
          continue;
        }
        store.deleteSession(id);
        rmSync(join(config.storage.dir, "traces", id), {
          recursive: true,
          force: true,
        });
        console.log(`deleted ${id}`);
      }
      return;
    }

    const json = args.includes("--json");
    const rows = store.listSessions();
    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No sessions captured yet.");
      return;
    }
    console.log(
      `${pad("SESSION", 10)}${pad("TASK", 14)}${pad("AGENT", 10)}${pad("REQS", 6)}${pad("IN", 10)}${pad("OUT", 8)}${pad("COST", 10)}CWD`,
    );
    for (const s of rows) {
      const task = s.meta?.task ?? "";
      const agent = s.meta?.agent ?? s.client ?? "";
      const cost = s.cost ? `$${s.cost.toFixed(4)}` : "$0";
      console.log(
        `${pad(s.id.slice(0, 8), 10)}${pad(task || "-", 14)}${pad(agent || "-", 10)}${pad(String(s.request_count), 6)}${pad(num(s.input_tokens), 10)}${pad(num(s.output_tokens), 8)}${pad(cost, 10)}${s.cwd ?? ""}`,
      );
    }
  } finally {
    store.close();
  }
}
