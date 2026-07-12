// Bedrock cache TTL and cross-session cache behavior probe.
//
// Tests:
// 1. Cold vs warm: two identical requests — first is write, second is read
// 2. Cross-session: same prefix, new session ID — does it cache hit?
// 3. TTL expiry: wait N seconds, repeat — when does cache expire?
// 4. stripTools effect: same request minus tools — confirm different cache key
//
// Run: AAP_PORT=8080 tsx benchmarks/cache-probe-bedrock.ts
//   (requires the aap proxy running, NOT in optimize mode)
//
// With wait-for-TTL:
//   PROBE_TTL=1 AAP_PORT=8080 tsx benchmarks/cache-probe-bedrock.ts

const AAP_PORT = process.env.AAP_PORT ?? "8080";
const PROBE_TTL = !!process.env.PROBE_TTL;
const BASE_URL = `http://127.0.0.1:${AAP_PORT}`;
const MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

interface Usage {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
}

interface Tool {
  name: string;
  description: string;
  input_schema: { type: string; properties?: Record<string, unknown> };
}

// Tools don't need individual cache_control markers — they sit between system (which
// has breakpoints) and messages (which has a breakpoint). The cache prefix includes
// them as long as system has breakpoints before them in the serialized request.
const TOOLS_FULL: Tool[] = [
  {
    name: "Bash",
    description: "Execute shell commands. " + "x".repeat(500),
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
    },
  },
  {
    name: "Read",
    description: "Read files from disk. " + "x".repeat(500),
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "Workflow",
    description: "Multi-agent orchestration. " + "x".repeat(2000),
    input_schema: {
      type: "object",
      properties: { script: { type: "string" } },
    },
  },
  {
    name: "Agent",
    description: "Spawn sub-agents. " + "x".repeat(800),
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
    },
  },
];

const TOOLS_STRIPPED: Tool[] = TOOLS_FULL.filter(
  (t) => !["Workflow", "Agent"].includes(t.name),
);

// System must be an array with cache_control breakpoints to activate caching.
// Mimics Claude Code's pattern: system[0] is a short preamble, system[1] has the
// first breakpoint, system[2] (the bulk of instructions) has the second breakpoint.
//
// IMPORTANT: Anthropic requires a MINIMUM of 2048 tokens per cached block for
// caching to activate (for all models). We pad to exceed this threshold.
const PADDING = "word ".repeat(3000); // ~3000 tokens (well above 2048 minimum)
const SYSTEM = [
  { type: "text", text: "You are a calculator." },
  {
    type: "text",
    text:
      "Respond with just the number, nothing else. No explanation. " + PADDING,
    cache_control: { type: "ephemeral" },
  },
  {
    type: "text",
    text: "Additional instructions for handling edge cases. " + PADDING,
    cache_control: { type: "ephemeral" },
  },
];

// Messages must include a cache_control breakpoint on the last user content block
// (the "trailing edge" breakpoint that Claude Code uses).
const MESSAGES = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "What is 2+2?",
        cache_control: { type: "ephemeral" },
      },
    ],
  },
];

let sessionCounter = 0;

async function call(
  label: string,
  opts: {
    tools?: Tool[];
    sessionId?: string;
    system?: unknown;
    messages?: unknown;
  } = {},
): Promise<Usage> {
  const sid =
    opts.sessionId ?? `probe-bedrock-${Date.now()}-${++sessionCounter}`;
  const url = `${BASE_URL}/${sid}/bedrock/model/${MODEL}/invoke`;

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 10,
    system: opts.system ?? SYSTEM,
    messages: opts.messages ?? MESSAGES,
    ...(opts.tools ? { tools: opts.tools } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { usage: Usage };
  const u = json.usage;
  const cached = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = u.input_tokens + cached + written;
  const readPct = total > 0 ? ((cached / total) * 100).toFixed(1) : "0.0";
  const writePct = total > 0 ? ((written / total) * 100).toFixed(1) : "0.0";

  console.log(
    `${label.padEnd(42)} input=${String(u.input_tokens).padStart(5)}  ` +
      `cached=${String(cached).padStart(5)}  ` +
      `written=${String(written).padStart(5)}  ` +
      `read%=${readPct.padStart(5)}  write%=${writePct.padStart(5)}`,
  );
  return u;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`\nBedrock cache probe (${MODEL})\n${"─".repeat(72)}`);
  console.log(`Proxy: ${BASE_URL}  TTL probe: ${PROBE_TTL}\n`);

  // Use a fixed session for the warm-up pair
  const warmSession = `probe-warm-${Date.now()}`;

  // --- Test 1: Cold write then warm read (same session) ---
  console.log("── Test 1: Cold vs Warm (same session) ──");
  await call("1a. cold write", { tools: TOOLS_FULL, sessionId: warmSession });
  await pause(1000);
  await call("1b. warm read", { tools: TOOLS_FULL, sessionId: warmSession });
  await pause(1000);

  // --- Test 2: Cross-session cache (same prefix, different session) ---
  console.log("\n── Test 2: Cross-session cache (same prefix) ──");
  const crossSession = `probe-cross-${Date.now()}`;
  await call("2. new session, same prefix", {
    tools: TOOLS_FULL,
    sessionId: crossSession,
  });
  await pause(1000);

  // --- Test 3: stripTools effect (different prefix) ---
  console.log("\n── Test 3: stripTools (Workflow+Agent removed) ──");
  const stripSession = `probe-strip-${Date.now()}`;
  await call("3a. stripped (cold - new prefix)", {
    tools: TOOLS_STRIPPED,
    sessionId: stripSession,
  });
  await pause(1000);
  await call("3b. stripped (warm - same prefix)", {
    tools: TOOLS_STRIPPED,
    sessionId: stripSession,
  });
  await pause(1000);

  // --- Test 4: No tools at all ---
  console.log("\n── Test 4: No tools (minimal prefix) ──");
  const noToolsSession = `probe-notools-${Date.now()}`;
  await call("4a. no tools (cold)", { sessionId: noToolsSession });
  await pause(1000);
  await call("4b. no tools (warm)", { sessionId: noToolsSession });

  // --- Test 5: TTL probe (optional, slow) ---
  if (PROBE_TTL) {
    console.log("\n── Test 5: TTL probe (waiting for cache expiry) ──");
    const ttlSession = `probe-ttl-${Date.now()}`;
    await call("5a. warm the cache", {
      tools: TOOLS_FULL,
      sessionId: ttlSession,
    });

    for (const waitSec of [60, 120, 180, 300, 600]) {
      console.log(`    ... waiting ${waitSec}s ...`);
      await pause(waitSec * 1000);
      const u = await call(`5b. after ${waitSec}s wait`, {
        tools: TOOLS_FULL,
        sessionId: ttlSession,
      });
      const cached = u.cache_read_input_tokens ?? 0;
      if (cached === 0) {
        console.log(`    ⚠ Cache expired after ${waitSec}s!`);
        break;
      }
    }
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log("Interpretation:");
  console.log("  1b cached > 0   → same-session cache works");
  console.log("  2  cached > 0   → cross-session cache works (same prefix)");
  console.log(
    "  3a cached = 0   → different prefix = cold start (strip effect)",
  );
  console.log("  3b cached > 0   → strip prefix warms after first request");
  console.log("  4  cached > 0   → minimal prefix also caches");
  if (PROBE_TTL) {
    console.log("  5  cached = 0   → cache TTL identified");
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
