const app = document.getElementById("app");

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

const num = (n) => (n ?? 0).toLocaleString();
const cost = (c) => (c ? `$${Number(c).toFixed(4)}` : "$0");
const shortId = (id) => (id ? esc(String(id).slice(0, 8)) : "—");

function fmtBytes(n) {
  if (!n) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function statusCell(s) {
  if (s == null) return `<span class="muted">—</span>`;
  const cls = s >= 200 && s < 400 ? "ok" : "err";
  return `<span class="${cls}">${s}</span>`;
}

function b64ToText(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

async function dashboard() {
  const [stats, sessions] = await Promise.all([
    api("/stats"),
    api("/sessions"),
  ]);
  const cards = [
    ["Sessions", num(stats.sessions)],
    ["Requests", num(stats.requests)],
    ["Input tokens", num(stats.input_tokens)],
    ["Output tokens", num(stats.output_tokens)],
    ["Est. cost", cost(stats.cost)],
  ];
  app.innerHTML = `
    <h2>Dashboard</h2>
    <div class="cards">
      ${cards
        .map(
          ([l, v]) =>
            `<div class="card"><div class="label">${l}</div><div class="value">${v}</div></div>`,
        )
        .join("")}
    </div>
    <h2>Recent sessions</h2>
    ${sessionsTable(sessions.slice(0, 15))}
  `;
}

function sessionsTable(sessions) {
  if (!sessions.length) return `<p class="empty">No sessions captured yet.</p>`;
  return `<table>
    <thead><tr>
      <th>Session</th><th>Client</th><th>cwd</th>
      <th class="num">Reqs</th><th class="num">In</th><th class="num">Out</th>
      <th class="num">Tools</th><th class="num">Cost</th><th>Last seen</th>
    </tr></thead>
    <tbody>
    ${sessions
      .map(
        (s) => `<tr>
      <td><a class="mono" href="#/sessions/${encodeURIComponent(s.id)}">${shortId(s.id)}</a></td>
      <td>${esc(s.client) || "<span class='muted'>—</span>"}</td>
      <td class="mono muted">${esc(s.cwd) || "—"}</td>
      <td class="num">${num(s.request_count)}</td>
      <td class="num">${num(s.input_tokens)}</td>
      <td class="num">${num(s.output_tokens)}</td>
      <td class="num">${num(s.tool_calls)}</td>
      <td class="num">${cost(s.cost)}</td>
      <td class="mono muted">${esc((s.last_seen_at || "").replace("T", " ").slice(0, 19))}</td>
    </tr>`,
      )
      .join("")}
    </tbody></table>`;
}

async function sessions() {
  const list = await api("/sessions");
  app.innerHTML = `<h2>Sessions</h2>${sessionsTable(list)}`;
}

async function sessionDetail(id) {
  const { session, requests } = await api(
    `/sessions/${encodeURIComponent(id)}`,
  );
  const rows = requests
    .map(
      (r) => `<tr>
      <td><a class="mono" href="#/requests/${encodeURIComponent(r.id)}">${shortId(r.id)}</a></td>
      <td>${esc(r.provider)}</td>
      <td>${esc(r.method)}</td>
      <td class="mono">${esc(r.path)}</td>
      <td>${statusCell(r.status)}</td>
      <td class="num">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</td>
      <td class="mono">${esc(r.model) || "—"}</td>
      <td class="num">${r.input_tokens == null ? "—" : num(r.input_tokens)}</td>
      <td class="num">${r.output_tokens == null ? "—" : num(r.output_tokens)}</td>
      <td>${esc(r.stop_reason) || "—"}</td>
      <td class="num">${num(r.tool_call_count)}</td>
      <td class="num">${cost(r.cost)}</td>
    </tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="crumb"><a href="#/sessions">Sessions</a> / ${shortId(session.id)}</div>
    <h2>Session ${shortId(session.id)}</h2>
    <div class="kv">
      <div class="k">id</div><div class="v">${esc(session.id)}</div>
      <div class="k">client</div><div class="v">${esc(session.client) || "—"}</div>
      <div class="k">cwd</div><div class="v">${esc(session.cwd) || "—"}</div>
      <div class="k">repo</div><div class="v">${esc(session.repo) || "—"}</div>
      <div class="k">started</div><div class="v">${esc(session.started_at) || "—"}</div>
    </div>
    <h2>Requests (${requests.length})</h2>
    ${
      requests.length
        ? `<table><thead><tr>
      <th>Request</th><th>Provider</th><th>Method</th><th>Path</th><th>Status</th>
      <th class="num">Latency</th><th>Model</th><th class="num">In</th><th class="num">Out</th>
      <th>Stop</th><th class="num">Tools</th><th class="num">Cost</th>
    </tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="empty">No requests.</p>`
    }`;
}

async function requestDetail(id) {
  const r = await api(`/requests/${encodeURIComponent(id)}?events=1`);
  const events = r.events || [];
  const responseEvent = events.find((e) => e.type === "response");
  const encoding =
    responseEvent &&
    responseEvent.headers &&
    responseEvent.headers["content-encoding"];
  const responseText = encoding
    ? `[${encoding}-encoded — run \`aap parse\` for metrics]`
    : events
        .filter((e) => e.type === "response_body")
        .map((e) => b64ToText(e.data))
        .join("");
  const tools = (r.toolCalls || []).map((t) => esc(t.name)).join(", ") || "—";

  app.innerHTML = `
    <div class="crumb"><a href="#/sessions/${encodeURIComponent(r.session_id)}">${shortId(r.session_id)}</a> / ${shortId(r.id)}</div>
    <h2>Request ${shortId(r.id)}</h2>
    <div class="kv">
      <div class="k">provider</div><div class="v">${esc(r.provider)}</div>
      <div class="k">path</div><div class="v">${esc(r.path)}</div>
      <div class="k">status</div><div class="v">${statusCell(r.status)}</div>
      <div class="k">latency</div><div class="v">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</div>
      <div class="k">model</div><div class="v">${esc(r.model) || "—"}</div>
      <div class="k">tokens</div><div class="v">in ${r.input_tokens ?? "—"} / out ${r.output_tokens ?? "—"}</div>
      <div class="k">stop reason</div><div class="v">${esc(r.stop_reason) || "—"}</div>
      <div class="k">tools</div><div class="v">${tools}</div>
      <div class="k">cost</div><div class="v">${cost(r.cost)}</div>
      <div class="k">bytes</div><div class="v">req ${fmtBytes(r.request_bytes)} / resp ${fmtBytes(r.response_bytes)}</div>
    </div>
    <h2>Response</h2>
    <pre>${esc(responseText) || '<span class="muted">no body</span>'}</pre>
    <h2>Events (${events.length})</h2>
    <div class="mono">
      ${events
        .map((e) => {
          const size = e.data ? ` (${e.data.length} b64 chars)` : "";
          return `<div class="event"><span class="type">${esc(e.type)}</span> <span class="muted">${new Date(e.ts).toISOString().slice(11, 23)}</span>${size}</div>`;
        })
        .join("")}
    </div>`;
}

async function render() {
  const hash = location.hash.slice(1) || "/";
  try {
    if (hash === "/") return await dashboard();
    if (hash === "/sessions") return await sessions();
    const s = hash.match(/^\/sessions\/(.+)$/);
    if (s) return await sessionDetail(decodeURIComponent(s[1]));
    const q = hash.match(/^\/requests\/(.+)$/);
    if (q) return await requestDetail(decodeURIComponent(q[1]));
    app.innerHTML = `<p class="empty">Not found.</p>`;
  } catch (err) {
    app.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById("refresh").addEventListener("click", render);
window.addEventListener("hashchange", render);
window.addEventListener("load", render);
