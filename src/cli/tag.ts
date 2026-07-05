import { loadConfig } from "../config/index.js";
import { openStore } from "../store/index.js";

// aap tag <session-id-or-prefix> key=value [key=value ...]
// Merge metadata into an existing session (e.g. a benchmark verify result).
export function tag(args: string[]): void {
  const prefix = args[0];
  const pairs = args.slice(1);
  if (!prefix || pairs.length === 0) {
    console.error("Usage: aap tag <session-id> key=value [key=value ...]");
    process.exitCode = 1;
    return;
  }

  const patch: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      console.error(`Invalid key=value pair: "${pair}"`);
      process.exitCode = 1;
      return;
    }
    patch[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    const id = store.resolveSessionId(prefix);
    if (!id) {
      console.error(`No session matches "${prefix}".`);
      process.exitCode = 1;
      return;
    }
    store.updateSessionMeta(id, patch);
    const tags = Object.entries(patch)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`tagged ${id.slice(0, 8)}  ${tags}`);
  } finally {
    store.close();
  }
}
