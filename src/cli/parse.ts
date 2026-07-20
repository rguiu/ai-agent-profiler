import { loadConfig } from "../config/index.js";
import {
  runParse,
  extractResponseText,
  readTraceEvents,
  parseTrace,
} from "../parse/index.js";
import { openStore } from "../store/index.js";

export async function parse(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const backfill = args.includes("--backfill-titles");
  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    const summary = await runParse(store, config.pricing, { all });
    console.log(
      `parsed ${summary.parsed}, failed ${summary.failed} (of ${summary.total} request${summary.total === 1 ? "" : "s"})`,
    );

    if (backfill) {
      const targets = store.requestsToParse(true);
      let backfilled = 0;
      for (const target of targets) {
        if (!target.session_id) continue;
        try {
          const events = await readTraceEvents(target.trace_file);
          const result = parseTrace(events);
          if (result.context.kind === "title") {
            const responseText = extractResponseText(events);
            if (
              responseText &&
              store.updateSessionTitle(target.session_id, responseText)
            )
              backfilled++;
          } else if (result.context.kind === "recap") {
            const responseText = extractResponseText(events);
            if (
              responseText &&
              store.updateSessionSummary(target.session_id, responseText)
            )
              backfilled++;
          }
        } catch {
          // skip broken traces during backfill
        }
      }
      if (backfilled > 0) {
        console.log(`backfilled titles/summaries for ${backfilled} session(s)`);
      }
    }
  } finally {
    store.close();
  }
}
