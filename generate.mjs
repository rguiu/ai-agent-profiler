#!/usr/bin/env node
// Snapshot a running AAP server to static JSON for gh-pages.
// Usage: BASE=http://localhost:8299 node generate.mjs
//
// Fetches ALL endpoints (stats, latency, trend, idle-gaps, projects, models,
// introspections, sessions, requests) so every UI tab works in the static demo.
// Scrubs private data (paths, usernames, emails, API keys).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = join(process.cwd(), "data");
const RESP_LIMIT = 6000;

// Must mirror fileKey() in app.js exactly.
function fileKey(path) {
  let p = path.replace(/^\//, "");
  p = p.replace(/\?/g, "__q__").replace(/=/g, "-").replace(/&/g, "__");
  p = p.replace(/\//g, "__");
  return p + ".json";
}

async function getJson(path) {
  const url = BASE + path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.json();
}

function scrubText(s) {
  return s
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/demo")
    .replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/demo")
    .replace(/\/private\/var\/folders\/[^"]+/g, "/private/tmp/scratch")
    .replace(/raulguiugallardo/gi, "demo")
    .replace(/raulguiu/gi, "demo")
    .replace(/rguiu/gi, "demo")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer REDACTED")
    .replace(/AKIA[0-9A-Z]{12,}/g, "AKIA-REDACTED")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com")
    .replace(/git@github\.com:[A-Za-z0-9._-]+\//g, "user@example.com:demo/")
    .replace(/git@github\.com:[^/]+\/[A-Za-z0-9._-]+\.git/g, "user@example.com:demo/repo.git")
    .replace(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git/g, "https://github.com/demo/repo.git")
    .replace(/https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9._-]+/gi, "https://www.linkedin.com/in/demo");
}

function scrub(value) {
  return JSON.parse(scrubText(JSON.stringify(value)));
}

function assembleResponseText(events) {
  let out = "";
  for (const e of events) {
    if (e.type !== "response_body" || typeof e.data !== "string" || !e.data)
      continue;
    let txt;
    try {
      txt = Buffer.from(e.data, "base64").toString("utf8");
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta || j.delta;
        if (d?.content) out += d.content;
        // Anthropic SSE
        if (j.type === "content_block_delta" && j.delta?.text) out += j.delta.text;
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function lean(detail) {
  const events = Array.isArray(detail.events) ? detail.events : [];
  let text = scrubText(assembleResponseText(events));
  const truncated = text.length > RESP_LIMIT;
  text = text.slice(0, RESP_LIMIT) + (truncated ? "\n\n…[truncated for static demo]" : "");
  const injected = Buffer.from(text, "utf8").toString("base64");
  let done = false;
  detail.events = events.map((e) => {
    const c = { ...e };
    if (c.headers && typeof c.headers === "object") {
      const h = { ...c.headers };
      for (const k of Object.keys(h)) {
        if (/^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-amz-security-token|x-amz-date)/i.test(k))
          h[k] = "[redacted]";
      }
      c.headers = h;
    }
    if (typeof c.data === "string") {
      if (c.type === "response_body" && !done && text) {
        c.data = injected;
        done = true;
      } else {
        c.data = "";
      }
    }
    return c;
  });
  return detail;
}

async function write(path, value) {
  const file = join(OUT, fileKey(path));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(scrub(value)));
}

// ── Session curation ────────────────────────────────────────────────────────
// Pick diverse sessions across clients, excluding bogus/empty ones.
const BOGUS_CLIENTS = new Set(["npx", "--help", "stockpilot", "stockpile", "stackpilote"]);
const MAX_SESSIONS = 10;
const MAX_REQUESTS_PER_SESSION = 60; // cap for page size in static demo

function curate(allSessions) {
  const candidates = allSessions
    .filter((s) => (s.request_count ?? 0) > 0)
    .filter((s) => !BOGUS_CLIENTS.has(s.client ?? ""));

  // Group by client
  const byClient = {};
  for (const s of candidates) {
    const c = s.client || "unknown";
    (byClient[c] = byClient[c] || []).push(s);
  }

  // Sort each group by request_count desc
  for (const c of Object.keys(byClient)) {
    byClient[c].sort((a, b) => (b.request_count ?? 0) - (a.request_count ?? 0));
  }

  // Round-robin pick from each client
  const picked = [];
  const clientKeys = Object.keys(byClient).sort((a, b) => byClient[b].length - byClient[a].length);
  let idx = 0;
  while (picked.length < MAX_SESSIONS) {
    let added = false;
    for (const client of clientKeys) {
      const pool = byClient[client];
      if (idx < pool.length) {
        picked.push(pool[idx]);
        added = true;
        if (picked.length >= MAX_SESSIONS) break;
      }
    }
    if (!added) break;
    idx++;
  }

  console.log(`Curated ${picked.length} sessions from ${candidates.length} candidates across ${clientKeys.length} clients`);
  for (const s of picked) {
    const cr = (s.cached_input_tokens ?? 0) / Math.max(1, s.input_tokens ?? 1) * 100;
    console.log(`  ${s.id.slice(0, 40)}  client=${(s.client||'?').padEnd(10)} reqs=${String(s.request_count).padEnd(4)} cost=$${(s.cost??0).toFixed(4)} cache=${cr.toFixed(0)}%`);
  }
  return picked;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT, { recursive: true });

  // Fetch all summary endpoints
  console.log("Fetching summary endpoints...");
  const [tools, commands, kinds, latency, trend, idleGaps, projects, models, allSessions, introspections] =
    await Promise.all([
      getJson("/tools"),
      getJson("/commands"),
      getJson("/kinds"),
      getJson("/stats/latency"),
      getJson("/stats/trend?days=7"),
      getJson("/stats/idle-gaps"),
      getJson("/projects"),
      getJson("/models"),
      getJson("/sessions"),
      getJson("/introspections"),
    ]);

  // Write summary files
  await write("/tools", tools);
  await write("/commands", commands);
  await write("/kinds", kinds);
  await write("/stats/latency", latency);
  await write("/stats/trend?days=7", trend);
  await write("/stats/idle-gaps", idleGaps);
  await write("/projects", projects);
  await write("/models", models);

  // Curate sessions
  const featured = curate(allSessions);
  await write("/sessions", featured);

  // Stats from curated sessions
  const sum = (k) => featured.reduce((a, s) => a + (s[k] || 0), 0);
  await write("/stats", {
    sessions: featured.length,
    requests: sum("request_count"),
    input_tokens: sum("input_tokens"),
    cached_input_tokens: sum("cached_input_tokens"),
    output_tokens: sum("output_tokens"),
    cost: sum("cost"),
  });

  // Write introspections
  await write("/introspections", introspections);
  if (Array.isArray(introspections)) {
    for (const intro of introspections) {
      try {
        const detail = await getJson(`/introspections/${encodeURIComponent(intro.id)}`);
        await write(`/introspections/${intro.id}`, detail);
      } catch {
        console.log(`  Introspection ${intro.id}: no detail available`);
      }
    }
  }

  // Fetch per-session data
  let reqCount = 0;
  for (const id of featured.map((s) => s.id)) {
    process.stdout.write(`  ${id.slice(0, 40)}... `);
    const detail = await getJson(`/sessions/${id}`);
    await write(`/sessions/${id}`, detail);

    await write(`/commands?session=${encodeURIComponent(id)}`,
      await getJson(`/commands?session=${encodeURIComponent(id)}`));
    await write(`/sessions/${id}/tool-calls`,
      await getJson(`/sessions/${encodeURIComponent(id)}/tool-calls`));

    const requests = Array.isArray(detail.requests) ? detail.requests : [];
    const capped = requests.slice(0, MAX_REQUESTS_PER_SESSION);

    let sessionReqCount = 0;
    for (const r of capped) {
      try {
        const events = lean(await getJson(`/requests/${r.id}?events=1`));
        await write(`/requests/${r.id}?events=1`, events);
        const messages = await getJson(`/requests/${r.id}/messages`);
        await write(`/requests/${r.id}/messages`, messages);
        sessionReqCount++;
      } catch (e) {
        if (sessionReqCount === 0) throw e;
      }
    }
    console.log(`${sessionReqCount} requests`);
    reqCount += sessionReqCount;
  }

  console.log(`\nDone: ${featured.length} sessions, ${reqCount} requests`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
