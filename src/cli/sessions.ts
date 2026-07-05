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
  const json = args.includes("--json");
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
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
