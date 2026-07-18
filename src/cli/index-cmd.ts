import { loadConfig } from "../config/index.js";
import { openSearchStore, runIndex } from "../search/index.js";
import { openStore } from "../store/index.js";

export async function index(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  const search = openSearchStore(config.storage.dir);
  try {
    const summary = await runIndex(store, search, { all });
    console.log(
      `indexed ${summary.indexed}, failed ${summary.failed} (of ${summary.total} request${summary.total === 1 ? "" : "s"}), ${summary.chunks} new chunk${summary.chunks === 1 ? "" : "s"}`,
    );
  } finally {
    search.close();
    store.close();
  }
}
