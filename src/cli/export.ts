import { loadConfig } from "../config/index.js";
import { recommend, type Recommendation } from "../recommend/index.js";
import { openStore, type SessionDetail } from "../store/index.js";

function num(value: number | null | undefined): string {
  return Math.round(value ?? 0)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function cost(value: number | null | undefined): string {
  return value ? `$${Number(value).toFixed(4)}` : "$0";
}

function dt(value: string | null): string {
  return value ? value.replace("T", " ").slice(0, 19) : "—";
}

export function renderMarkdown(
  detail: SessionDetail,
  recommendations: Recommendation[],
): string {
  const { session, requests, analysis, optimize } = detail;
  const inputTokens = requests.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
  const outputTokens = requests.reduce((a, r) => a + (r.output_tokens ?? 0), 0);
  const totalCost = requests.reduce((a, r) => a + (r.cost ?? 0), 0);

  const lines: string[] = [];
  lines.push(`# Session ${session.id}`, "");
  lines.push(`- **Client:** ${session.client ?? "—"}`);
  lines.push(`- **Working dir:** ${session.cwd ?? "—"}`);
  lines.push(`- **Repo:** ${session.repo ?? "—"}`);
  lines.push(`- **Started:** ${dt(session.started_at)}`, "");

  lines.push("## Summary", "");
  lines.push(`- Requests: ${requests.length}`);
  lines.push(`- Input tokens: ${num(inputTokens)}`);
  lines.push(`- Output tokens: ${num(outputTokens)}`);
  lines.push(`- Estimated cost: ${cost(totalCost)}`);
  lines.push(
    `- Static context re-sent: ~${num(analysis.context.system_tokens_total)} system + ~${num(analysis.context.tools_tokens_total)} tool-def tokens`,
    "",
  );

  if (optimize.length > 0) {
    const totalSaved = optimize.reduce((a, o) => a + o.tokens_saved, 0);
    lines.push("## Optimizations applied", "");
    lines.push(`- Total tokens saved: ~${num(totalSaved)}`, "");
    lines.push("| Strategy | Actions | Tokens saved |");
    lines.push("| --- | ---: | ---: |");
    for (const o of optimize) {
      lines.push(`| ${o.type} | ${num(o.count)} | ~${num(o.tokens_saved)} |`);
    }
    lines.push("");
  }

  lines.push("## Recommendations", "");
  if (recommendations.length === 0) {
    lines.push("_No issues detected._", "");
  } else {
    for (const rec of recommendations) {
      lines.push(`- **[${rec.severity}] ${rec.title}**`);
      lines.push(`  ${rec.detail}`);
    }
    lines.push("");
  }

  if (analysis.toolUsage.length > 0) {
    lines.push("## Tool usage", "");
    lines.push("| Tool | Calls | Result tokens |");
    lines.push("| --- | ---: | ---: |");
    for (const tool of analysis.toolUsage) {
      lines.push(
        `| ${tool.name} | ${num(tool.count)} | ~${num(tool.result_tokens)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Requests", "");
  lines.push(
    "| # | Started | Provider | Model | Status | Latency | In | Out | Tools | Cost |",
  );
  lines.push(
    "| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  requests.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${dt(r.started_at)} | ${r.provider} | ${r.model ?? "—"} | ${r.status ?? "—"} | ${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"} | ${num(r.input_tokens)} | ${num(r.output_tokens)} | ${num(r.tool_call_count)} | ${cost(r.cost)} |`,
    );
  });
  lines.push("");

  return lines.join("\n");
}

export function exportSession(args: string[]): void {
  const json = args.includes("--json");
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("Usage: aap export <session-id> [--json]");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const store = openStore(config.storage.dir);
  try {
    const detail = store.getSession(id);
    if (!detail) {
      console.error(`Session "${id}" not found`);
      process.exitCode = 1;
      return;
    }
    const recommendations = recommend(detail);
    if (json) {
      console.log(JSON.stringify({ ...detail, recommendations }, null, 2));
    } else {
      console.log(renderMarkdown(detail, recommendations));
    }
  } finally {
    store.close();
  }
}
