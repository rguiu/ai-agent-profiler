import { analyzeIdleGaps } from "../analyze/index.js";
import { openStore } from "../store/index.js";

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60 * 1000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 60 * 60 * 1000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function idleGaps(args: string[]): void {
  const json = args.includes("--json");
  const config = { storage: { dir: process.env.AAP_DATA_DIR ?? "" } };
  if (!config.storage.dir)
    config.storage.dir = `${process.env.HOME ?? "~"}/.aap/data`;
  const store = openStore(config.storage.dir);
  const rows = store.requestTimestamps();
  const result = analyzeIdleGaps(rows);

  if (json) {
    console.log(JSON.stringify(result));
    store.close();
    return;
  }

  if (result.totalGaps === 0) {
    console.log("No idle gaps to analyze — need sessions with 2+ requests.");
    store.close();
    return;
  }

  console.log(
    `Idle-gap distribution across ${result.sessionsAnalyzed} session(s) (${result.totalGaps} total gaps):\n`,
  );
  console.log("  GLOBAL");
  for (const b of result.globalBuckets) {
    console.log(
      `    ${b.bucket.padEnd(8)} ${String(b.count).padStart(6)}  (${b.percent.toFixed(1)}%)`,
    );
  }

  console.log(`\n  Cache TTL implications:`);
  const fiveMinH = result.globalBuckets.find((b) => b.bucket === "5m-1h");
  const overOneH = result.globalBuckets.find((b) => b.bucket === ">1h");
  if (fiveMinH && fiveMinH.count > 0) {
    console.log(
      `    ${fiveMinH.count} gap(s) fall in the 5m–1h window → 1h cache TTL upgrade would preserve cache for these.`,
    );
  }
  if (overOneH && overOneH.count > 0) {
    console.log(
      `    ${overOneH.count} gap(s) exceed 1h → keep-alive pings might help if recurring within sessions.`,
    );
  }

  console.log("\n  PER SESSION");
  for (const s of result.sessions) {
    console.log(
      `\n    ${s.sessionId.slice(0, 20)}…  ${s.requestCount} reqs, ${s.gaps} gaps  |  median ${formatMs(s.medianGapMs)}  p90 ${formatMs(s.p90GapMs)}`,
    );
    for (const b of s.buckets) {
      console.log(
        `      ${b.bucket.padEnd(8)} ${String(b.count).padStart(5)}  (${b.percent.toFixed(1)}%)`,
      );
    }
  }

  store.close();
}
