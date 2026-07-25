#!/usr/bin/env node

// Synthetic demo-data generator for AI Agent Profiler gh-pages.
// Produces realistic sessions with authentic cache-hit patterns (95-99.9%).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const OUT = join(process.cwd(), "data");

// ── providers ──────────────────────────────────────────────────────────────

const PROVIDERS = {
  anthropic:  { name: "anthropic",  format: "anthropic", models: ["claude-sonnet-4-20250514", "claude-haiku-4-20250514"],   priceIn: 0.000003,  priceOut: 0.000015,  priceCache: 0.0000003  },
  openai:     { name: "openai",     format: "openai",    models: ["gpt-4o", "gpt-4o-mini"],                                   priceIn: 0.0000025, priceOut: 0.00001,   priceCache: 0.00000125 },
  deepseek:   { name: "deepseek",   format: "openai",    models: ["deepseek-v4-pro", "deepseek-chat"],                       priceIn: 0.00000127, priceOut: 0.0000011, priceCache: 0.00000014 },
  openrouter: { name: "openrouter", format: "openai",    models: ["anthropic/claude-sonnet-4-20250514"],                     priceIn: 0.000003,  priceOut: 0.000015,  priceCache: 0.0000003  },
  ollama:     { name: "ollama",     format: "openai",    models: ["codellama:13b", "llama3.1:8b"],                            priceIn: 0,          priceOut: 0,          priceCache: 0           },
};

// ── session definitions ─────────────────────────────────────────────────────

const SESSIONS = [
  {
    id: "demo-01-refactor-auth",
    provider: "anthropic", model: "claude-sonnet-4-20250514", client: "claude",
    cwd: "/Users/demo/Projects/python-api",
    repo: "user@example.com:demo/python-api.git",
    started: "2026-07-22T09:15:00.000Z", durationMin: 105,
    meta: { task: "refactor-auth", branch: "feat/oauth2-migration" },
    // Scenario: long refactoring session, many requests, high cache
    mainReqs: 22, searchReqs: 3, titleReqs: 1, recapReqs: 1,
    avgLatency: 12000, avgToolsPerMain: 5,
    contextGrowth: "steep", // grows from 3K to 180K input tokens
  },
  {
    id: "demo-02-dashboard-ui",
    provider: "openai", model: "gpt-4o", client: "opencode",
    cwd: "/Users/demo/Projects/react-dashboard",
    repo: "user@example.com:demo/react-dashboard.git",
    started: "2026-07-23T14:30:00.000Z", durationMin: 130,
    meta: { task: "build-analytics-dashboard", branch: "feat/analytics" },
    mainReqs: 25, searchReqs: 4, titleReqs: 1, recapReqs: 2, compactReqs: 1,
    avgLatency: 15000, avgToolsPerMain: 4,
    contextGrowth: "moderate", // grows to 120K
  },
  {
    id: "demo-03-debug-ci",
    provider: "deepseek", model: "deepseek-v4-pro", client: "opencode",
    cwd: "/Users/demo/Projects/ci-pipeline",
    repo: "user@example.com:demo/ci-pipeline.git",
    started: "2026-07-24T11:00:00.000Z", durationMin: 85,
    meta: { task: "fix-flaky-tests", branch: "fix/test-stability" },
    mainReqs: 16, searchReqs: 3, titleReqs: 1, recapReqs: 1,
    avgLatency: 18000, avgToolsPerMain: 6,
    contextGrowth: "steep", // lots of reading
  },
  {
    id: "demo-04-openapi-docs",
    provider: "openrouter", model: "anthropic/claude-sonnet-4-20250514", client: "claude",
    cwd: "/Users/demo/Projects/api-docs",
    repo: "user@example.com:demo/api-docs.git",
    started: "2026-07-25T08:45:00.000Z", durationMin: 60,
    meta: { task: "generate-openapi-spec", branch: "feat/openapi-v3" },
    mainReqs: 12, searchReqs: 3, titleReqs: 1, recapReqs: 1,
    avgLatency: 10000, avgToolsPerMain: 4,
    contextGrowth: "moderate",
  },
  {
    id: "demo-05-legacy-explore",
    provider: "ollama", model: "codellama:13b", client: "opencode",
    cwd: "/Users/demo/Projects/legacy-monolith",
    repo: "user@example.com:demo/legacy-monolith.git",
    started: "2026-07-25T16:00:00.000Z", durationMin: 45,
    meta: null,
    mainReqs: 9, searchReqs: 3, titleReqs: 1, recapReqs: 1,
    avgLatency: 22000, avgToolsPerMain: 3,
    contextGrowth: "flat", // local model, smaller context
  },
  {
    id: "demo-06-add-tests",
    provider: "anthropic", model: "claude-sonnet-4-20250514", client: "claude",
    cwd: "/Users/demo/Projects/ecommerce-backend",
    repo: "user@example.com:demo/ecommerce-backend.git",
    started: "2026-07-26T10:00:00.000Z", durationMin: 120,
    meta: { task: "add-integration-tests", branch: "feat/test-coverage" },
    mainReqs: 24, searchReqs: 4, titleReqs: 1, recapReqs: 2, compactReqs: 1,
    avgLatency: 14000, avgToolsPerMain: 5,
    contextGrowth: "steep",
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

const rng = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const coin = (p = 0.5) => Math.random() < p;
const gauss = (mean, sd) => Math.max(mean * 0.3, mean + (Math.random() * 2 - 1) * sd);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const uuid = () => randomUUID();

const TOOLS = ["read","edit","write","bash","grep","glob","task","todowrite","webfetch","question"];

const COMMANDS = [
  { command: "npm test", category: "build" },
  { command: "npm run lint", category: "build" },
  { command: "npm run typecheck", category: "build" },
  { command: "npx vitest run", category: "build" },
  { command: "python -m pytest", category: "build" },
  { command: "pytest -xvs", category: "build" },
  { command: "ruff check", category: "build" },
  { command: "cargo test", category: "build" },
  { command: "go test ./...", category: "build" },
  { command: "node scripts/build.mjs", category: "build" },
  { command: "git diff --stat", category: "vcs" },
  { command: "git log --oneline -10", category: "vcs" },
  { command: "git status", category: "vcs" },
  { command: "git add -A", category: "vcs" },
  { command: "git commit -m", category: "vcs" },
  { command: "docker build -t app .", category: "docker" },
  { command: "docker-compose up -d", category: "docker" },
  { command: "ls -la src/", category: "fs" },
  { command: "mkdir -p tests/unit", category: "fs" },
  { command: "find . -name '*.test.*'", category: "search" },
];

const SYSTEM_PROMPTS = [
  "You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nIMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.",
  "You are Claude Code, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.",
];

const TITLE_PROMPT = "You are a title generator. You output ONLY a thread title. Nothing else.";

const USER_TASKS = [
  "Refactor the authentication module to support OAuth 2.0 with PKCE flow. Update all middleware, add token refresh logic, and ensure backward compatibility with the existing session-based auth.",
  "Build a real-time analytics dashboard with WebSocket updates. Include charts for user engagement, revenue, and churn. Use the existing chart components.",
  "Debug the CI pipeline — integration tests are failing intermittently on the staging environment. The failures seem related to database connection timeouts.",
  "Generate a complete OpenAPI 3.0 specification from the existing route definitions. Include all endpoints, request/response schemas, and authentication requirements.",
  "Explore this legacy codebase and map out the architecture. Identify dead code, circular dependencies, and areas that need refactoring.",
  "Add comprehensive integration tests for the checkout and payment processing flows. Cover edge cases: invalid cards, timeouts, retry logic, and idempotency.",
  "Optimize the database query performance. Several endpoints are timing out under load. Profile the slow queries and add appropriate indexes.",
  "Migrate the REST API to GraphQL. Start with the user and product schemas, add resolvers, and set up Apollo Server.",
  "Implement rate limiting and request throttling across all API endpoints. Use a token bucket algorithm with per-user and per-IP limits.",
  "Add structured logging with correlation IDs across all services. Integrate with the existing OpenTelemetry setup.",
];

const SEARCH_TASKS = [
  "Search the codebase for all authentication-related code: middleware, guards, token handling, session management, and user model",
  "Find all TODO and FIXME comments across the project, including deprecated functions and tech debt markers",
  "Search for all API endpoint definitions, route handlers, and controller functions to document the full surface",
  "Find all test files and verify which endpoints/functions have test coverage vs which don't",
  "Search for database query patterns, raw SQL strings, and ORM usage to identify slow queries",
];

// ── REALISTIC CACHE MODEL ──────────────────────────────────────────────────
//
// In agent sessions the prompt cache serves system prompt, tool definitions,
// and all previous conversation turns. Only the new user message and new tool
// results are uncached. Context accumulates → cache rate grows to 95-99.9%.

// ── GENERATE REQUESTS ───────────────────────────────────────────────────────
//
// REALISTIC CACHE MODEL:
// In agent sessions the system prompt, tool definitions, and all previous
// conversation turns are served from the provider's prompt cache. Only the
// latest user message and new tool results count as uncached input.
// This yields 95-99.9% cache-hit rates in practice.

function generateRequests(sessDef, provider) {
  const requests = [];
  const start = new Date(sessDef.started);
  const end = new Date(start.getTime() + sessDef.durationMin * 60 * 1000);
  const totalMs = end.getTime() - start.getTime();

  // Build request list
  const kinds = [];
  for (let i = 0; i < sessDef.mainReqs; i++) kinds.push("main");
  for (let i = 0; i < (sessDef.searchReqs || 0); i++) kinds.push("search");
  for (let i = 0; i < (sessDef.titleReqs || 0); i++) kinds.push("title");
  for (let i = 0; i < (sessDef.recapReqs || 0); i++) kinds.push("recap");
  for (let i = 0; i < (sessDef.compactReqs || 0); i++) kinds.push("compact");
  const titleIdx = kinds.indexOf("title");
  if (titleIdx > 0) { kinds.splice(titleIdx, 1); kinds.unshift("title"); }

  // Context accumulates: system prompt + tool defs + all previous turns.
  // Each turn adds the user message, assistant response, and tool results,
  // all of which get cached for subsequent requests.
  let cachedContext = rng(5000, 10000); // system + tool defs for first turn

  const availableMs = totalMs * 0.95;
  const avgGap = kinds.length > 1 ? availableMs / (kinds.length - 1) : 0;

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const progress = i / kinds.length;
    const t = start.getTime() + i * avgGap + rng(-avgGap * 0.2, avgGap * 0.2);
    const reqStart = new Date(clamp(t, start.getTime(), end.getTime() - 2000));

    const isTitle = kind === "title";
    const isCompact = kind === "compact";
    const isRecap = kind === "recap";
    const isSearch = kind === "search";
    const isMain = kind === "main";

    // Uncached (new) input: latest user message + fresh tool results.
    let newTokens;
    if (isTitle) {
      newTokens = rng(40, 80);
    } else if (isCompact) {
      newTokens = rng(3000, 8000);
    } else if (isRecap) {
      newTokens = rng(800, 2500);
    } else if (isSearch) {
      newTokens = rng(150, 500);
    } else {
      const numTools = clamp(Math.round(gauss(sessDef.avgToolsPerMain, 2)), 1, 10);
      newTokens = rng(200, 1500) + (numTools * rng(150, 800));
    }

    // Tool calls
    let numTools = 0;
    if (isMain || isSearch) {
      numTools = clamp(Math.round(gauss(sessDef.avgToolsPerMain, 2)), isMain ? 1 : 1, isMain ? 10 : 4);
    }

    // Output tokens
    let outputTokens;
    if (isTitle) outputTokens = rng(8, 35);
    else if (isCompact) outputTokens = rng(1500, 6000);
    else if (isRecap) outputTokens = rng(400, 2000);
    else if (isSearch) outputTokens = rng(80, 1500);
    else outputTokens = clamp(Math.round(gauss(numTools * 250, 150)), 50, 6000);

    // Cached = everything accumulated so far (system, tools, all past turns).
    // For title: independent small context.
    const effectiveCached = isTitle ? rng(450, 750) : cachedContext;

    // Accumulate for next turn: new tokens + output + tool results all cached.
    if (isMain || isSearch) {
      cachedContext += newTokens + outputTokens + (numTools * rng(300, 3000));
      if (cachedContext > 300000) cachedContext = rng(220000, 300000);
    } else if (isRecap || isCompact) {
      cachedContext = rng(5000, 18000);
    }

    // Cache write occasionally
    const cacheWrite = coin(0.06) && !isTitle && progress > 0.05 ? rng(1000, 8000) : null;

    const stopReason = numTools > 0 ? "tool_calls" : "stop";
    const baseLat = isTitle ? rng(700, 2000) : isCompact ? rng(8000, 25000) : isRecap ? rng(5000, 18000) : gauss(sessDef.avgLatency, sessDef.avgLatency * 0.35);
    const latencyMs = clamp(Math.round(baseLat), isTitle ? 400 : 1500, 60000);
    const reqEnd = new Date(reqStart.getTime() + latencyMs);

    const path = `/${sessDef.id}/${provider.name}/v1/chat/completions`;
    const totalTokens = effectiveCached + newTokens;
    const reqBytes = clamp(Math.round(totalTokens * rng(3, 5)), 1500, 800000);
    const respBytes = clamp(Math.round(outputTokens * rng(3, 6)), 300, 500000);

    const costVal = provider.priceIn * newTokens + provider.priceOut * outputTokens + provider.priceCache * effectiveCached;
    let model = sessDef.model;
    if (isTitle && coin(0.5)) model = provider.models.find(m => m !== sessDef.model) || sessDef.model;

    requests.push({
      id: uuid(), provider: provider.name, method: "POST", path,
      status: coin(0.015) && !isTitle ? (coin(0.5) ? 429 : 500) : 200,
      latency_ms: latencyMs, started_at: reqStart.toISOString(), ended_at: reqEnd.toISOString(),
      request_bytes: reqBytes, response_bytes: respBytes, error: null,
      keep_alive: coin(0.03) ? 1000 : 0, format: provider.format, model,
      input_tokens: newTokens, output_tokens: outputTokens, stop_reason: stopReason,
      cost: Math.max(0, costVal), tool_call_count: numTools,
      cached_input_tokens: effectiveCached, cache_creation_input_tokens: cacheWrite, kind,
    });
  }

  return requests;
}

// ── TOOL CALLS ──────────────────────────────────────────────────────────────

function generateToolCalls(sessDef, requests) {
  const calls = [];
  for (const r of requests) {
    for (let i = 0; i < (r.tool_call_count || 0); i++) {
      const t = pick(TOOLS);
      const resultTokens = t === "read" ? rng(200, 15000)
        : t === "bash" ? rng(100, 8000)
        : t === "grep" ? rng(50, 5000)
        : t === "glob" ? rng(20, 3000)
        : t === "task" ? rng(200, 10000)
        : rng(5, 2000);

      const args = {};
      if (t === "read") args.filePath = `/Users/demo/Projects/demo/src/${pick(["index.ts","app.ts","auth.ts","router.ts","db.ts","handlers.ts","middleware.ts","types.ts","utils.ts","config.ts","server.ts"])}`;
      else if (t === "edit") { args.filePath = `/Users/demo/Projects/demo/src/${pick(["auth.ts","router.ts","app.ts"])}`; args.oldString = `// old implementation`; args.newString = `// updated implementation`; }
      else if (t === "bash") args.command = pick(COMMANDS).command;
      else if (t === "grep") args.pattern = pick(["TODO","FIXME","function\s+\w+","import.*from","class\s+\w+","export\s+(default\s+)?(class|function|const)"]);
      else if (t === "glob") args.pattern = `src/**/*.${pick(["ts","py","go","rs","js","tsx"])}`;
      else if (t === "task") { args.description = pick(["Find patterns","Explore codebase","Search tests","Map architecture"]); args.prompt = `Search for ${pick(["error handling","auth logic","database queries","API routes","test files","middleware chain","dependency injection"])}`; args.subagent_type = "explore"; }
      else if (t === "write") { args.filePath = `/Users/demo/Projects/demo/src/${pick(["new-file.ts","test.ts","config.ts"])}`; args.content = "// Generated file"; }

      calls.push({
        request_id: r.id, ordinal: i, name: t,
        arguments: JSON.stringify(args),
        result_tokens: resultTokens,
        started_at: new Date(new Date(r.started_at).getTime() + rng(1500, Math.max(2000, r.latency_ms - 1000))).toISOString(),
      });
    }
  }
  return calls.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
}

// ── ANALYSIS / RECOMMENDATIONS ──────────────────────────────────────────────

function generateAnalysis(sessDef, requests, toolCalls) {
  const toolUsage = {};
  for (const tc of toolCalls) {
    if (!toolUsage[tc.name]) toolUsage[tc.name] = { name: tc.name, count: 0, result_tokens: 0 };
    toolUsage[tc.name].count++;
    toolUsage[tc.name].result_tokens += tc.result_tokens;
  }
  const toolUsageArr = Object.values(toolUsage).sort((a, b) => b.count - a.count);

  const repeated = [];
  if (coin(0.5) && toolUsageArr.length > 0) {
    const tu = toolUsageArr[0];
    if (tu.count >= 3) repeated.push({ name: tu.name, arguments: '{"command":"npm test"}', count: rng(2, Math.min(tu.count, 6)) });
  }

  const growth = requests.map(r => ({
    id: r.id, started_at: r.started_at, input_tokens: r.input_tokens,
    output_tokens: r.output_tokens, cached_input_tokens: r.cached_input_tokens,
    cache_creation_input_tokens: r.cache_creation_input_tokens,
  }));

  const context = {
    requests: requests.length,
    system_tokens_total: requests.filter(r => r.kind !== "title").length * rng(2000, 4000),
    tools_tokens_total: requests.filter(r => r.tool_call_count > 0).length * rng(800, 2000),
    input_tokens_total: requests.reduce((s, r) => s + r.input_tokens + r.cached_input_tokens, 0),
    cached_input_tokens_total: requests.reduce((s, r) => s + r.cached_input_tokens, 0),
  };

  const sessionCmds = {};
  for (let i = 0; i < rng(4, 10); i++) {
    const c = pick(COMMANDS);
    if (!sessionCmds[c.command]) sessionCmds[c.command] = { command: c.command, category: c.category, count: 0, resultTokens: 0 };
    sessionCmds[c.command].count += rng(1, 12);
    sessionCmds[c.command].resultTokens += rng(500, 12000);
  }

  return { toolUsage: toolUsageArr, repeated, growth, context, commands: Object.values(sessionCmds) };
}

function generateRecommendations(sessDef, analysis, requests) {
  const recs = [];
  const maxAmp = Math.max(...requests.filter(r => r.tool_call_count > 0).map(r => r.tool_call_count), 0);
  if (maxAmp >= 5) {
    recs.push({ kind: "high_amplification", severity: maxAmp >= 7 ? "high" : "warn",
      title: `${maxAmp} tool calls in a single request`,
      detail: `One request triggered ${maxAmp} sequential tool calls before returning. Consider breaking into smaller focused requests — each tool call returns tokens that inflate the next request's context.` });
  }
  const firstInput = requests[0] ? requests[0].input_tokens + requests[0].cached_input_tokens : 1;
  const lastInput = requests[requests.length - 1] ? requests[requests.length - 1].input_tokens + requests[requests.length - 1].cached_input_tokens : 1;
  const growthFactor = Math.round(lastInput / Math.max(firstInput, 1));
  if (growthFactor > 40) {
    recs.push({ kind: "context_growth", severity: growthFactor > 100 ? "high" : "warn",
      title: `Context grew ${growthFactor}x from first to last request`,
      detail: `Early requests had ~${Math.round(firstInput/1000)}K input tokens, final requests reached ~${Math.round(lastInput/1000)}K. This amplifies per-request cost. Use intermediate compaction or subagents to keep context lean.` });
  } else if (growthFactor > 10) {
    recs.push({ kind: "context_growth", severity: "info",
      title: `Context grew ${growthFactor}x over the session`,
      detail: `Normal growth for a productive session. Cache hit rate is ${requests.filter(r => r.cached_input_tokens > 0).length > 0 ? Math.round(requests.reduce((s, r) => s + r.cached_input_tokens, 0) / Math.max(1, requests.reduce((s, r) => s + r.input_tokens + r.cached_input_tokens, 0)) * 100) : 0}% which offsets most of the cost.` });
  }
  if (analysis.repeated.length > 0) {
    recs.push({ kind: "repeated_tool_call", severity: "warn",
      title: `${analysis.repeated[0].name} ran ${analysis.repeated[0].count}x with identical arguments`,
      detail: `The same call repeated ${analysis.repeated[0].count} times with the same arguments. Cache results locally or use a subagent to batch reads.` });
  }
  const readCount = analysis.toolUsage.find(t => t.name === "read")?.count || 0;
  if (readCount > 20) {
    recs.push({ kind: "context_duplication", severity: "info",
      title: `${readCount} file reads — check for duplicates`,
      detail: `High read volume detected. Some files may have been read multiple times. Use grep/glob for targeted lookups instead of reading entire files.` });
  }
  return recs;
}

// ── MESSAGES ────────────────────────────────────────────────────────────────

function generateMessages(request, toolCalls) {
  const reqTcs = toolCalls.filter(tc => tc.request_id === request.id);
  const msgs = []; let idx = 0;

  // System prompt
  const sysPrompt = request.kind === "title" ? TITLE_PROMPT : pick(SYSTEM_PROMPTS);
  const sysBytes = Buffer.from(sysPrompt, "utf8").length;
  msgs.push({ index: idx++, role: "system", bytes: sysBytes, tokens: Math.round(sysBytes / 4), hasToolCalls: false, toolCallNames: [], toolResultFor: null, preview: sysPrompt.slice(0, 160) });

  // Tool definitions
  if (request.kind !== "title" && request.tool_call_count > 0) {
    const nTools = rng(8, 15);
    const toolNames = TOOLS.slice(0, nTools);
    const toolsBytes = nTools * rng(500, 800);
    msgs.push({ index: idx++, role: "system", bytes: toolsBytes, tokens: Math.round(toolsBytes / 4), hasToolCalls: false, toolCallNames: [], toolResultFor: null, preview: `[${nTools} tools: ${toolNames.slice(0,6).join(", ")}...]` });
  }

  // User message
  const task = request.kind === "search" ? pick(SEARCH_TASKS) : pick(USER_TASKS);
  const userBytes = Buffer.from(task, "utf8").length;
  msgs.push({ index: idx++, role: "user", bytes: userBytes, tokens: Math.round(userBytes / 4), hasToolCalls: false, toolCallNames: [], toolResultFor: null, preview: task.slice(0, 160) });

  // Assistant + tool results
  if (reqTcs.length > 0) {
    const asstBytes = rng(400, 3000);
    msgs.push({ index: idx++, role: "assistant", bytes: asstBytes, tokens: Math.round(asstBytes / 4), hasToolCalls: true, toolCallNames: reqTcs.map(tc => tc.name), toolResultFor: null, preview: "I'll investigate that. Let me start by examining the relevant code..." });

    for (const tc of reqTcs) {
      const resultBytes = tc.result_tokens * 4 + rng(100, 500);
      msgs.push({ index: idx++, role: "tool", bytes: resultBytes, tokens: tc.result_tokens, hasToolCalls: false, toolCallNames: [], toolResultFor: tc.name, preview: `[${tc.name} result: ${tc.result_tokens} tokens]` });
    }
  }

  // Final assistant response (if stopped)
  if (request.stop_reason === "stop") {
    const finalBytes = rng(800, 6000);
    msgs.push({ index: idx++, role: "assistant", bytes: finalBytes, tokens: Math.round(finalBytes / 4), hasToolCalls: false, toolCallNames: [], toolResultFor: null, preview: "Here's the implementation. I've made the following changes..." });
  }

  const totalsByRole = {};
  let totalBytes = 0;
  for (const m of msgs) {
    if (!totalsByRole[m.role]) totalsByRole[m.role] = { role: m.role, count: 0, bytes: 0, tokens: 0 };
    totalsByRole[m.role].count++;
    totalsByRole[m.role].bytes += m.bytes;
    totalsByRole[m.role].tokens += m.tokens;
    totalBytes += m.bytes;
  }

  return {
    model: request.model,
    messageCount: msgs.length,
    totalBytes,
    totalTokens: request.input_tokens + request.cached_input_tokens + (request.cache_creation_input_tokens || 0),
    tools: { count: msgs.filter(m => m.role === "system" && m.toolCallNames.length === 0).length > 1 ? rng(8, 15) : 0, bytes: rng(8000, 25000), tokens: rng(2000, 6000) },
    totalsByRole: Object.values(totalsByRole),
    messages: msgs,
  };
}

// ── EVENTS ──────────────────────────────────────────────────────────────────

function generateEvents(request) {
  const tid = request.id.slice(0, 8);
  const responseText = pick([
    "Looking at the authentication module, I can see several areas that need refactoring for OAuth 2.0 support...",
    "The analytics dashboard is now rendering correctly. I've added real-time WebSocket updates and the following chart components...",
    "The CI pipeline failures are caused by a race condition in the database connection pool. When multiple test suites run in parallel...",
    "Based on my analysis, here is the complete OpenAPI specification covering all endpoints...",
    "I've explored the codebase and mapped out the architecture. Here are the key findings...",
    "The integration tests are now passing. I've covered the critical payment flows including edge cases...",
  ]);
  const injected = Buffer.from(responseText, "utf8").toString("base64");

  return [
    { type: "request", ts: new Date(request.started_at).getTime(), sessionId: tid, requestId: request.id, provider: request.provider, method: "POST", path: request.path, httpVersion: "1.1", headers: { authorization: "[redacted]", "content-type": "application/json", host: "api.example.com", "user-agent": "ai-agent-profiler/1.0" } },
    { type: "request_body", ts: new Date(request.started_at).getTime() + 2, data: "" },
    { type: "response", ts: new Date(request.ended_at).getTime() - 40, status: request.status, statusMessage: request.status === 200 ? "OK" : "Error", headers: { "content-type": "text/event-stream", "x-request-id": request.id } },
    { type: "response_body", ts: new Date(request.ended_at).getTime() - 35, data: injected },
    { type: "end", ts: new Date(request.ended_at).getTime(), status: request.status, latencyMs: request.latency_ms, requestBytes: request.request_bytes, responseBytes: request.response_bytes },
  ];
}

// ── FILE KEY (must mirror app.js) ──────────────────────────────────────────

function fileKey(path) {
  let p = path.replace(/^\//, "").replace(/\?/g, "__q__").replace(/=/g, "-").replace(/&/g, "__").replace(/\//g, "__");
  return p + ".json";
}

async function write(path, value) {
  const file = join(OUT, fileKey(path));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT, { recursive: true });

  const allSessions = [];
  const allToolCalls = [];
  let allRequests = [];
  const toolAgg = {}, kindAgg = {}, cmdAgg = {}, modelAgg = {};

  for (const sessDef of SESSIONS) {
    const provider = PROVIDERS[sessDef.provider];
    const requests = generateRequests(sessDef, provider);
    const toolCalls = generateToolCalls(sessDef, requests);
    const analysis = generateAnalysis(sessDef, requests, toolCalls);
    const recs = generateRecommendations(sessDef, analysis, requests);

    const sessionObj = {
      id: sessDef.id, client: sessDef.client, cwd: sessDef.cwd, repo: sessDef.repo,
      started_at: sessDef.started, first_seen_at: requests[0]?.started_at || sessDef.started,
      last_seen_at: requests[requests.length - 1]?.ended_at || sessDef.started, meta: sessDef.meta,
      request_count: requests.length,
      input_tokens: requests.reduce((s, r) => s + r.input_tokens + r.cached_input_tokens, 0),
      cached_input_tokens: requests.reduce((s, r) => s + r.cached_input_tokens, 0),
      output_tokens: requests.reduce((s, r) => s + r.output_tokens, 0),
      cost: requests.reduce((s, r) => s + r.cost, 0),
      tool_calls: toolCalls.length,
    };

    const detail = { session: sessionObj, requests, analysis, recommendations: recs, regenerations: {}, searchReadChains: [] };
    await write(`/sessions/${sessionObj.id}`, detail);
    await write(`/sessions/${sessionObj.id}/tool-calls`, toolCalls);
    await write(`/commands?session=${sessionObj.id}`, analysis.commands);

    // Per-request files
    for (const r of requests) {
      const msgs = generateMessages(r, toolCalls);
      const events = generateEvents(r);
      const evtDetail = {
        id: r.id, session_id: sessionObj.id, provider: r.provider, method: r.method, path: r.path,
        trace_file: `/Users/demo/.aap/data/traces/${r.id}.ndjson`,
        started_at: r.started_at, ended_at: r.ended_at, status: r.status, latency_ms: r.latency_ms,
        request_bytes: r.request_bytes, response_bytes: r.response_bytes, error: r.error,
        keep_alive: r.keep_alive || null, format: r.format, model: r.model,
        input_tokens: r.input_tokens, output_tokens: r.output_tokens, stop_reason: r.stop_reason,
        streaming: 1, tool_call_count: r.tool_call_count, cost: r.cost,
        parsed_at: new Date(new Date(r.ended_at).getTime() + 3000).toISOString(),
        message_count: msgs.messageCount,
        system_tokens: msgs.totalsByRole.filter(x => x.role === "system").reduce((s, x) => s + x.tokens, 0),
        tools_defined: msgs.tools.count, tools_tokens: msgs.tools.tokens,
        cached_input_tokens: r.cached_input_tokens, cache_creation_input_tokens: r.cache_creation_input_tokens,
        kind: r.kind,
        toolCalls: toolCalls.filter(tc => tc.request_id === r.id).map(tc => ({
          ordinal: tc.ordinal, name: tc.name, arguments: tc.arguments,
          tool_id: `call_${String(tc.ordinal).padStart(2,"0")}_${r.id.slice(0,12)}`,
          result_bytes: tc.result_tokens * 4, result_tokens: tc.result_tokens,
        })),
        events,
      };
      await write(`/requests/${r.id}?events=1`, evtDetail);
      await write(`/requests/${r.id}/messages`, msgs);
    }

    allSessions.push(sessionObj);
    allRequests = allRequests.concat(requests);
    allToolCalls.push(...toolCalls);

    // Aggregations
    for (const c of analysis.commands) {
      const k = c.command;
      if (!cmdAgg[k]) cmdAgg[k] = { command: c.command, category: c.category, count: 0, resultTokens: 0 };
      cmdAgg[k].count += c.count;
      cmdAgg[k].resultTokens += c.resultTokens;
    }
    for (const tu of analysis.toolUsage) {
      if (!toolAgg[tu.name]) toolAgg[tu.name] = { name: tu.name, count: 0, result_tokens: 0 };
      toolAgg[tu.name].count += tu.count;
      toolAgg[tu.name].result_tokens += tu.result_tokens;
    }
    for (const r of requests) {
      if (!kindAgg[r.kind]) kindAgg[r.kind] = { kind: r.kind, requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
      kindAgg[r.kind].requests++;
      kindAgg[r.kind].input_tokens += r.input_tokens + r.cached_input_tokens;
      kindAgg[r.kind].output_tokens += r.output_tokens;
      kindAgg[r.kind].cost += r.cost;
      // Model aggregation
      const mKey = r.model;
      if (!modelAgg[mKey]) {
        modelAgg[mKey] = { model: r.model, provider: r.provider, request_count: 0, session_count: 0, sessions: new Set(), cost: 0, tool_calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, latencies: [] };
      }
      modelAgg[mKey].request_count++;
      modelAgg[mKey].sessions.add(sessDef.id);
      modelAgg[mKey].cost += r.cost;
      modelAgg[mKey].tool_calls += r.tool_call_count;
      modelAgg[mKey].input_tokens += r.input_tokens + r.cached_input_tokens;
      modelAgg[mKey].cached_input_tokens += r.cached_input_tokens;
      modelAgg[mKey].output_tokens += r.output_tokens;
      modelAgg[mKey].latencies.push(r.latency_ms);
    }

    console.log(`  ${sessDef.id}: ${requests.length} reqs, ${toolCalls.length} tools, $${sessionObj.cost.toFixed(4)}, cache ${Math.round(sessionObj.cached_input_tokens / Math.max(1, sessionObj.input_tokens) * 100)}%`);
  }

  // Write aggregate files
  await write("/sessions", allSessions);
  await write("/stats", {
    sessions: allSessions.length, requests: allRequests.length,
    input_tokens: allRequests.reduce((s, r) => s + r.input_tokens + r.cached_input_tokens, 0),
    cached_input_tokens: allRequests.reduce((s, r) => s + r.cached_input_tokens, 0),
    output_tokens: allRequests.reduce((s, r) => s + r.output_tokens, 0),
    cost: allRequests.reduce((s, r) => s + r.cost, 0),
  });
  await write("/tools", Object.values(toolAgg).sort((a, b) => b.count - a.count));
  await write("/kinds", Object.values(kindAgg).sort((a, b) => b.requests - a.requests));
  await write("/commands", Object.values(cmdAgg).sort((a, b) => b.count - a.count));

  // Models data
  const modelsList = Object.values(modelAgg).map(m => {
    const lats = m.latencies.sort((a, b) => a - b);
    return {
      model: m.model, provider: m.provider, request_count: m.request_count,
      session_count: m.sessions.size, cost: m.cost, tool_calls: m.tool_calls,
      input_tokens: m.input_tokens, cached_input_tokens: m.cached_input_tokens,
      output_tokens: m.output_tokens,
      cache_hit_rate: m.input_tokens > 0 ? m.cached_input_tokens / m.input_tokens : 0,
      latency_p50: lats[Math.floor(lats.length * 0.5)] || null,
      latency_p95: lats[Math.floor(lats.length * 0.95)] || null,
    };
  });
  await write("/models", modelsList);

  const totalReqs = allRequests.length;
  const totalCost = allRequests.reduce((s, r) => s + r.cost, 0);
  const totalIn = allRequests.reduce((s, r) => s + r.input_tokens + r.cached_input_tokens, 0);
  const totalCache = allRequests.reduce((s, r) => s + r.cached_input_tokens, 0);
  console.log(`\nDone: ${allSessions.length} sessions, ${totalReqs} requests, ${allToolCalls.length} tool calls`);
  console.log(`Cost: $${totalCost.toFixed(2)}, Cache rate: ${Math.round(totalCache / Math.max(1, totalIn) * 100)}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
