// Static-demo generator for the AI Agent Profiler UI (gh-pages, root layout).
//
// Usage:  BASE=http://localhost:8299 node generate.mjs
//
// Snapshots the live JSON API to ./data/*.json so the SPA runs on GitHub Pages
// with no backend. Strips heavy request bodies, reconstructs a readable
// (truncated) response body from the SSE stream, and deep-scrubs everything.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Buffer } from "node:buffer";

const BASE = process.env.BASE || "http://localhost:8299";
const OUT = join(process.cwd(), "data");
const RESP_LIMIT = 6000; // chars of reconstructed response text to keep

// The two sessions behind the article's DeepSeek "twist" tables.
const FEATURED = [
  "bench-opencode-iterative-fix-plus-20260710122817-1",
  "bench-opencode-iterative-fix-plus-20260710123727-1",
];

// Must mirror fileKey() in app.js exactly.
function fileKey(path) {
  let p = path.replace(/^\//, "");
  p = p.replace(/\?/g, "__q__").replace(/=/g, "-").replace(/&/g, "__");
  p = p.replace(/\//g, "__");
  return p + ".json";
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return res.json();
}

function scrubText(s) {
  return s
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/demo")
    .replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/demo")
    .replace(/raulguiugallardo/g, "demo")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer REDACTED")
    .replace(/AKIA[0-9A-Z]{12,}/g, "AKIA-REDACTED")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com");
}
function scrub(value) {
  return JSON.parse(scrubText(JSON.stringify(value)));
}

// Reassemble assistant text from OpenAI-style SSE `data:` chunks.
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
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) out += d.content;
      } catch {
        /* ignore non-JSON keepalive lines */
      }
    }
  }
  return out;
}

// Keep event envelopes; drop request bodies; inject one readable response body.
function lean(detail) {
  const events = Array.isArray(detail.events) ? detail.events : [];
  let text = scrubText(assembleResponseText(events));
  const truncated = text.length > RESP_LIMIT;
  text =
    text.slice(0, RESP_LIMIT) +
    (truncated ? "\n\n…[response truncated for static demo]" : "");
  const injected = Buffer.from(text, "utf8").toString("base64");
  let done = false;
  detail.events = events.map((e) => {
    const c = { ...e };
    if (c.headers && typeof c.headers === "object") {
      const h = { ...c.headers };
      for (const k of Object.keys(h)) {
        if (
          /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-amz-security-token|x-amz-date)/i.test(
            k,
          )
        )
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

async function main() {
  await mkdir(OUT, { recursive: true });
  await write("/tools", await getJson("/tools"));
  await write("/commands", await getJson("/commands"));

  const allSessions = await getJson("/sessions");
  const featured = allSessions.filter((s) => FEATURED.includes(s.id));
  await write("/sessions", featured);

  const sum = (k) => featured.reduce((a, s) => a + (s[k] || 0), 0);
  await write("/stats", {
    sessions: featured.length,
    requests: sum("request_count"),
    input_tokens: sum("input_tokens"),
    cached_input_tokens: sum("cached_input_tokens"),
    output_tokens: sum("output_tokens"),
    cost: sum("cost"),
  });

  let reqCount = 0;
  for (const id of FEATURED) {
    const detail = await getJson(`/sessions/${id}`);
    await write(`/sessions/${id}`, detail);
    await write(
      `/commands?session=${id}`,
      await getJson(`/commands?session=${encodeURIComponent(id)}`),
    );
    const requests = Array.isArray(detail.requests) ? detail.requests : [];
    for (const r of requests) {
      await write(
        `/requests/${r.id}?events=1`,
        lean(await getJson(`/requests/${r.id}?events=1`)),
      );
      await write(
        `/requests/${r.id}/messages`,
        await getJson(`/requests/${r.id}/messages`),
      );
      reqCount++;
    }
    console.log(`  ${id}: ${requests.length} requests`);
  }
  console.log(`done: ${featured.length} sessions, ${reqCount} requests`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
