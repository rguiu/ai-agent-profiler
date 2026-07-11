// Static-demo generator for the AI Agent Profiler UI.
//
// Snapshots the live JSON API (served by `aap serve`) to flat files under
// demo/data/, so the SPA can run on GitHub Pages with no backend.
//
// Usage:  BASE=http://localhost:8299 node generate.mjs
//
// - Features a curated set of sessions (see FEATURED); trims the session list
//   to those so the UI never links to a view without data.
// - Strips the heavy base64 bodies from request `events` (keeps envelopes) and
//   redacts auth headers.
// - Deep-scrubs every payload: local paths, username, API keys, emails.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const BASE = process.env.BASE || "http://localhost:8299";
const OUT = join(process.cwd(), "data");

// The two sessions that back the article's DeepSeek "twist" tables:
//   baseline (49 req, $0.046) and the +491% optimize run (117 req, $0.272).
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

function scrub(value) {
  let s = JSON.stringify(value);
  s = s.replace(/\/Users\/[A-Za-z0-9._-]+/g, "/Users/demo");
  s = s.replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/demo");
  s = s.replace(/raulguiugallardo/g, "demo");
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED");
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer REDACTED");
  s = s.replace(/AKIA[0-9A-Z]{12,}/g, "AKIA-REDACTED");
  s = s.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "user@example.com",
  );
  return JSON.parse(s);
}

// Drop giant base64 bodies and redact sensitive headers from request events.
function lean(detail) {
  if (Array.isArray(detail.events)) {
    detail.events = detail.events.map((e) => {
      const c = { ...e };
      if (typeof c.data === "string") c.data = "";
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
      return c;
    });
  }
  return detail;
}

async function write(path, value) {
  const file = join(OUT, fileKey(path));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(scrub(value)));
  return file;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Global aggregates (real numbers across the whole capture DB).
  await write("/tools", await getJson("/tools"));
  await write("/commands", await getJson("/commands"));

  // Trim the session list to the featured ones.
  const allSessions = await getJson("/sessions");
  const featured = allSessions.filter((s) => FEATURED.includes(s.id));
  await write("/sessions", featured);

  // Stats reflect ONLY the featured sessions (not the whole capture DB), so the
  // dashboard totals stay consistent with the trimmed session list.
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
      const rd = lean(await getJson(`/requests/${r.id}?events=1`));
      await write(`/requests/${r.id}?events=1`, rd);
      await write(
        `/requests/${r.id}/messages`,
        await getJson(`/requests/${r.id}/messages`),
      );
      reqCount++;
    }
    console.log(`  ${id}: ${requests.length} requests`);
  }

  console.log(
    `done: ${featured.length} sessions, ${reqCount} requests → ${OUT}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
