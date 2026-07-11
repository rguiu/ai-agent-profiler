import { loadConfig } from "../config/index.js";
import { simulateOptimize, overridesFor } from "../optimize/index.js";
import { openStore } from "../store/index.js";

export async function optimize(args: string[]): Promise<void> {
  const sessionPrefix = args[0];
  if (!sessionPrefix) {
    console.error("Usage: aap optimize <session-id> [--all]");
    console.error("  Simulates --optimize on an existing session (dry-run).");
    console.error(
      "  Shows what optimizations would have fired and how many tokens saved.",
    );
    process.exitCode = 1;
    return;
  }

  const enableAll = args.includes("--all");
  const config = loadConfig();
  const store = openStore(config.storage.dir);

  try {
    const sessionId = store.resolveSessionId(sessionPrefix);
    if (!sessionId) {
      console.error(`Session "${sessionPrefix}" not found`);
      process.exitCode = 1;
      return;
    }

    // Resolve provider from the session's first request, then apply
    // profile-based overrides (e.g. insertBreakpoints for Bedrock/Anthropic).
    const detail = store.getSession(sessionId);
    const provider = detail?.requests?.[0]?.provider ?? "";
    const profileOverrides = overridesFor("auto", provider);
    const optimizeConfig = {
      ...(profileOverrides ?? {}),
      ...(enableAll ? { pruneStale: true } : {}),
    };

    const result = await simulateOptimize(
      store,
      sessionId,
      optimizeConfig,
      config.pricing,
    );

    console.log(`\nOptimize dry-run: ${result.sessionId}`);
    console.log(`${"─".repeat(60)}`);
    console.log(`Requests:          ${result.totalRequests}`);
    console.log(`Total input tokens: ${n(result.totalInputTokens)}`);
    console.log(`Total result tokens: ${n(result.totalResultTokens)}`);
    console.log(`${"─".repeat(60)}`);
    console.log(
      `Tokens saved:      ~${n(result.tokensSaved)} (${result.savingsPercent}% of result tokens)`,
    );
    console.log();

    if (Object.keys(result.byType).length > 0) {
      console.log("By optimization type:");
      for (const [type, data] of Object.entries(result.byType)) {
        console.log(
          `  ${type.padEnd(15)} ${String(data.count).padStart(4)} actions  ~${n(data.tokensSaved)} tokens saved`,
        );
      }
      console.log();
    }

    if (result.cache) {
      const { baseline, optimized, inputCostDelta } = result.cache;
      console.log("DeepSeek prefix-cache cost (input side):");
      console.log(
        `  baseline   hit ${pct(baseline.hitRate)}  miss ${n(baseline.missTokens)} tok${money(baseline.inputCost)}`,
      );
      console.log(
        `  optimized  hit ${pct(optimized.hitRate)}  miss ${n(optimized.missTokens)} tok${money(optimized.inputCost)}`,
      );
      if (inputCostDelta !== null) {
        const verb = inputCostDelta > 0 ? "COSTS MORE" : "saves";
        console.log(
          `  → optimize layer ${verb} $${Math.abs(inputCostDelta).toFixed(4)} on input via cache effect`,
        );
      }
      console.log();
    }

    if (result.actions.length > 0 && !args.includes("--quiet")) {
      console.log("Actions (chronological):");
      for (const action of result.actions.slice(0, 30)) {
        console.log(
          `  [turn ${String(action.turn).padStart(2)}] ${action.type.padEnd(13)} ${action.detail}`,
        );
      }
      if (result.actions.length > 30) {
        console.log(`  ... and ${result.actions.length - 30} more`);
      }
    }
  } finally {
    store.close();
  }
}

function n(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function money(cost: number | null): string {
  return cost === null ? "" : `  $${cost.toFixed(4)}`;
}
