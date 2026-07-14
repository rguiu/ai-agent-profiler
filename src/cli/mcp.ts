import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/index.js";
import {
  analyzeIdleGaps,
  commandBreakdown,
  detectSearchReadChains,
} from "../analyze/index.js";
import { collectSummaries } from "./compare.js";
import { recommend } from "../recommend/index.js";
import { openStore, type Store } from "../store/index.js";

function readEvents(traceFile: string): unknown[] | undefined {
  try {
    const content = readFileSync(traceFile, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
}

function registerTools(server: McpServer, store: Store): void {
  server.tool(
    "list_sessions",
    "List captured sessions with rolled-up metrics",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.listSessions()) }],
    }),
  );

  server.tool(
    "get_session",
    "Full detail for one session: metadata, requests, and analysis",
    { id: z.string().describe("Session id") },
    async ({ id }) => {
      const detail = store.getSession(id);
      if (!detail)
        return {
          content: [{ type: "text", text: `Session "${id}" not found` }],
        };
      return {
        content: [{ type: "text", text: JSON.stringify(detail) }],
      };
    },
  );

  server.tool(
    "get_request",
    "One request: metadata, metrics, tool calls, and optionally raw trace events",
    {
      id: z.string().describe("Request id"),
      events: z
        .enum(["0", "1"])
        .optional()
        .describe("Include raw trace events (1) or not (0, default)"),
    },
    async ({ id, events }) => {
      const detail = store.getRequest(id);
      if (!detail)
        return {
          content: [{ type: "text", text: `Request "${id}" not found` }],
        };
      if (events === "1" && detail.trace_file) {
        detail.events = readEvents(detail.trace_file);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(detail) }],
      };
    },
  );

  server.tool(
    "search_requests",
    "Find requests by provider, model, or tool name",
    {
      provider: z
        .string()
        .optional()
        .describe("Provider name (e.g. anthropic, deepseek)"),
      model: z
        .string()
        .optional()
        .describe("Model substring (e.g. claude-sonnet)"),
      tool: z
        .string()
        .optional()
        .describe("Tool name (requests containing this tool call)"),
      limit: z.string().optional().describe("Max results (default 50)"),
    },
    async ({ provider, model, tool, limit: limitStr }) => {
      const limit = limitStr ? Number(limitStr) : 50;
      const where: string[] = [];
      const params: Array<string | number> = [];

      if (tool) {
        where.push("tc.name = ?");
        params.push(tool);
      }
      if (provider) {
        where.push("r.provider = ?");
        params.push(provider);
      }
      if (model) {
        where.push("m.model LIKE '%' || ? || '%'");
        params.push(model);
      }
      params.push(limit);

      const join = tool ? "JOIN tool_calls tc ON tc.request_id = r.id" : "";
      const distinct = tool ? "DISTINCT " : "";
      const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const sql = `SELECT ${distinct}r.id, r.session_id, r.provider, r.method, r.path, r.status, r.latency_ms, r.started_at, m.model, m.input_tokens, m.output_tokens, m.cost, m.stop_reason
               FROM requests r
               ${join}
               LEFT JOIN metrics m ON m.request_id = r.id
               ${whereClause}
               ORDER BY r.started_at DESC LIMIT ?`;

      const rows = store.rawQuery(sql, ...params);
      return {
        content: [{ type: "text", text: JSON.stringify(rows) }],
      };
    },
  );

  server.tool(
    "recommend",
    "Analyse a session and return actionable findings (repeated file reads, redundant tool calls, high token amplification, context duplication, context growth)",
    { id: z.string().describe("Session id") },
    async ({ id }) => {
      const detail = store.getSession(id);
      if (!detail)
        return {
          content: [{ type: "text", text: `Session "${id}" not found` }],
        };
      const chains = detectSearchReadChains(store.sessionToolCalls(id));
      return {
        content: [
          { type: "text", text: JSON.stringify(recommend(detail, chains)) },
        ],
      };
    },
  );

  server.tool(
    "compare",
    "Compare two or more sessions side by side (requests, tokens, cost, tool calls, tool result tokens, wall time, recommendation count)",
    { ids: z.array(z.string()).describe("Session ids to compare") },
    async ({ ids }) => {
      const { summaries, missing } = collectSummaries(store, ids);
      return {
        content: [
          { type: "text", text: JSON.stringify({ summaries, missing }) },
        ],
      };
    },
  );

  server.tool(
    "command_breakdown",
    "Break down shell (bash) commands the agent ran, grouped by program, with call counts and cumulative result tokens — shows which commands cost the most context.",
    {
      session: z
        .string()
        .optional()
        .describe("Optional session id to scope to"),
    },
    async ({ session }) => {
      const rows = commandBreakdown(store.bashToolCalls(session));
      return {
        content: [{ type: "text", text: JSON.stringify(rows) }],
      };
    },
  );

  server.tool(
    "stats",
    "Global aggregate stats (sessions, requests, tokens, cost)",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.stats()) }],
    }),
  );

  server.tool(
    "top_tools",
    "Tool-usage breakdown: tool name, call count, and cumulative result tokens",
    {},
    async () => ({
      content: [
        { type: "text", text: JSON.stringify(store.globalToolUsage()) },
      ],
    }),
  );

  server.tool(
    "idle_gaps",
    "Distribution of idle gaps between requests across all sessions, bucketed into <5m (cache alive), 5m-1h (1h TTL would help), >1h (keep-alive needed).",
    {},
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(analyzeIdleGaps(store.requestTimestamps())),
        },
      ],
    }),
  );

  server.tool(
    "projects",
    "All projects (cwd + repo) with session count, total cost, and total tokens.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.projects()) }],
    }),
  );

  server.tool(
    "session_timeline",
    "Sessions grouped by day with count, request count, and total cost. Use to spot trends over time.",
    {
      days: z
        .number()
        .optional()
        .describe("How many days back to look. Omit for all-time."),
    },
    async ({ days }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(store.sessionTimeline(days)),
        },
      ],
    }),
  );

  server.tool(
    "session_lengths",
    "Per-session stats: request count, cost, and total tokens. Sorted by largest first. Use to find expensive or long-running sessions.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.sessionLengths()) }],
    }),
  );

  server.tool(
    "raw_sql",
    "Run a read-only SQL query against the profiler's SQLite database. Tables: sessions, requests, metrics, tool_calls. Use for custom analysis.",
    { sql: z.string().describe("SQL SELECT statement") },
    async ({ sql }) => {
      try {
        const result = store.rawQuery(sql);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Query error: ${(err as Error).message}` },
          ],
        };
      }
    },
  );
}

export async function mcp(): Promise<void> {
  const config = loadConfig();
  const store = openStore(config.storage.dir);

  const server = new McpServer({ name: "aap", version: "1" });
  registerTools(server, store);

  let closed = false;
  const closeStore = (): void => {
    if (closed) return;
    closed = true;
    store.close();
  };
  process.on("SIGINT", () => {
    closeStore();
    process.exit(0);
  });
  process.on("exit", closeStore);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise(() => {});
}
