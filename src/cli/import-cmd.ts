import { loadConfig } from "../config/index.js";
import { openSearchStore, runTranscriptImport } from "../search/index.js";
import { openStore } from "../store/index.js";

// aap import [--claude] [--opencode] [--include-proxied]
// With no source flag, both sources are imported.
export function importTranscripts(args: string[]): void {
  const claudeOnly = args.includes("--claude");
  const opencodeOnly = args.includes("--opencode");
  const includeProxied = args.includes("--include-proxied");
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  const search = openSearchStore(config.storage.dir);
  try {
    const summary = runTranscriptImport(store, search, {
      claude: opencodeOnly ? claudeOnly : true,
      opencode: claudeOnly ? opencodeOnly : true,
      includeProxied,
    });
    console.log(
      `claude: ${summary.claudeMessages} message(s) from ${summary.claudeTranscripts} transcript(s)`,
    );
    console.log(
      `opencode: ${summary.opencodeMessages} message(s) from ${summary.opencodeSessions} session(s)` +
        (summary.opencodeSkippedProxied > 0
          ? ` (${summary.opencodeSkippedProxied} skipped — already proxied; use --include-proxied to force)`
          : ""),
    );
    console.log(`${summary.chunks} new chunk(s)`);
  } finally {
    search.close();
    store.close();
  }
}
