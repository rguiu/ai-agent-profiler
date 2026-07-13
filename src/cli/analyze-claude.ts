import {
  computeStats,
  locateTranscript,
  newestTranscriptFor,
  parseTranscript,
  projectSavings,
} from "../analyze/claude-transcript.js";

// `aap analyze-claude <session-id|path>` — READ-ONLY inspection of a Claude
// Code transcript. Reconstructs the active conversation path, reports token
// usage, and projects what compaction would save. Never writes to the file.
export function analyzeClaude(args: string[]): void {
  const positional = args.filter((a) => !a.startsWith("--"));
  const jsonOut = args.includes("--json");
  const stripIdx = args.indexOf("--strip-tools");
  const stripTools =
    stripIdx >= 0 && args[stripIdx + 1]
      ? args[stripIdx + 1]!.split(",").map((s) => s.trim())
      : undefined;

  let target = positional[0];
  if (!target) {
    // Fall back to the newest transcript for the current directory.
    target = newestTranscriptFor(process.cwd()) ?? undefined;
    if (!target) {
      console.error(
        "Usage: aap analyze-claude <session-id|path.jsonl> [--strip-tools A,B] [--json]",
      );
      console.error(
        "  Read-only analysis of a Claude Code session transcript.",
      );
      process.exitCode = 1;
      return;
    }
  }

  const path = locateTranscript(target, { cwd: process.cwd() });
  if (!path) {
    console.error(`Transcript not found for "${target}"`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseTranscript(path);
  const stats = computeStats(parsed);
  const savings = projectSavings(parsed, { stripTools });

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          path: parsed.path,
          structure: {
            totalEvents: parsed.totalEvents,
            chainedEvents: parsed.chainedEvents,
            activePathEvents: parsed.activePathEvents,
            abandonedEvents: parsed.abandonedEvents,
            leafCount: parsed.leafCount,
            branchPoints: parsed.branchPoints,
            eventTypeCounts: parsed.eventTypeCounts,
          },
          stats,
          savings,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nClaude transcript: ${parsed.path}`);
  console.log("─".repeat(66));
  console.log("Structure (tree walk — active leaf → root):");
  console.log(`  total events:        ${n(parsed.totalEvents)}`);
  console.log(
    `  active-path events:  ${n(parsed.activePathEvents)}  ` +
      `(${n(parsed.abandonedEvents)} abandoned on side branches)`,
  );
  console.log(
    `  leaves / branches:   ${parsed.leafCount} / ${parsed.branchPoints}`,
  );
  const typeStr = Object.entries(parsed.eventTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}=${c}`)
    .join("  ");
  console.log(`  event types:         ${typeStr}`);
  console.log("─".repeat(66));

  console.log("Conversation (API-visible messages on active path):");
  console.log(
    `  messages:            ${n(stats.messageCount)}  ` +
      `(${n(stats.userMessages)} user, ${n(stats.assistantMessages)} assistant)`,
  );
  console.log(`  estimated tokens:    ~${n(stats.estimatedTokens)}`);
  console.log(
    `  reported cache read: ${n(stats.reportedCacheReadTokens)} tokens ` +
      `(from assistant usage)`,
  );
  console.log(
    `  reported cache write:${n(stats.reportedCacheCreationTokens)} tokens`,
  );
  console.log(
    `  tool results:        ${n(stats.toolResultCount)}  ` +
      `(~${n(stats.toolResultTokens)} tokens)`,
  );
  console.log("─".repeat(66));

  const toolEntries = Object.entries(stats.tokensByTool).sort(
    (a, b) => b[1] - a[1],
  );
  if (toolEntries.length > 0) {
    console.log("Tokens by tool (result content):");
    for (const [name, tokens] of toolEntries.slice(0, 12)) {
      console.log(`  ${name.padEnd(20)} ~${n(tokens)} tokens`);
    }
    console.log("─".repeat(66));
  }

  if (stats.largestResults.length > 0) {
    console.log("Largest tool results:");
    for (const r of stats.largestResults) {
      console.log(
        `  ${(r.toolName ?? "(unknown)").padEnd(16)} ~${n(r.tokens)} tokens  ` +
          `(${n(r.bytes)} bytes)`,
      );
    }
    console.log("─".repeat(66));
  }

  console.log("Projected savings (DRY RUN — nothing is written):");
  for (const s of savings) {
    console.log(
      `  ${s.strategy.padEnd(16)} ~${n(s.tokensSaved).padStart(8)} tokens  ` +
        `${s.detail}`,
    );
  }
  const total = savings.reduce((sum, s) => sum + s.tokensSaved, 0);
  console.log(`  ${"─".repeat(50)}`);
  console.log(
    `  ${"combined".padEnd(16)} ~${n(total).padStart(8)} tokens ` +
      `(~${pct(total, stats.estimatedTokens)} of conversation)`,
  );
  console.log();
  console.log(
    "Note: read-only. To take effect, an edited transcript must be reloaded",
  );
  console.log("via `claude --resume <id>` — Claude ignores file edits mid-run.");
  console.log();
}

function n(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}
