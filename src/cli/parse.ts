import { loadConfig } from "../config/index.js";
import { runParse } from "../parse/index.js";
import { openStore } from "../store/index.js";

export function parse(args: string[]): void {
  const all = args.includes("--all");
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    const summary = runParse(store, config.pricing, { all });
    console.log(
      `parsed ${summary.parsed}, failed ${summary.failed} (of ${summary.total} request${summary.total === 1 ? "" : "s"})`,
    );
  } finally {
    store.close();
  }
}
