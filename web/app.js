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
const dt = (s) => (s ? esc(String(s).replace("T", " ").slice(0, 19)) : "—");

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
  const [stats, sessions, tools] = await Promise.all([
    api("/stats"),
    api("/sessions"),
    api("/tools"),
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
    <h2>Tool usage</h2>
    ${toolBars(tools)}
    <h2>Recent sessions</h2>
    ${sessionsTable(sessions.slice(0, 15))}
  `;
}

function toolBars(items) {
  if (!items || !items.length)
    return `<p class="empty">No tool calls recorded. Run <code>aap parse</code>.</p>`;
  const max = Math.max(...items.map((t) => t.count), 1);
  return `<div class="bars">${items
    .map((t) => {
      const amp = t.result_tokens
        ? ` · ~${num(t.result_tokens)} result tok`
        : "";
      return `<div class="bar-row"><span class="bar-label mono">${esc(t.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${((t.count / max) * 100).toFixed(1)}%"></span></span><span class="bar-val num">${num(t.count)}${amp}</span></div>`;
    })
    .join("")}</div>`;
}

function repeatedTable(items) {
  if (!items || !items.length)
    return `<p class="empty">No repeated tool calls in this session.</p>`;
  return `<table><thead><tr><th class="num">×</th><th>Tool</th><th>Arguments</th></tr></thead><tbody>${items
    .map((t) => {
      let args = t.arguments || "";
      try {
        if (args) args = JSON.stringify(JSON.parse(args));
      } catch {
        /* keep raw */
      }
      return `<tr><td class="num">${num(t.count)}</td><td>${esc(t.name)}</td><td class="mono">${esc(args) || '<span class="muted">—</span>'}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function growthChart(points) {
  const vals = (points || []).map((p) => p.input_tokens ?? 0);
  if (vals.length < 2 || vals.every((v) => v === 0))
    return `<p class="empty">Not enough parsed data yet — run <code>aap parse</code>.</p>`;
  const w = 640;
  const h = 160;
  const pad = 28;
  const max = Math.max(...vals, 1);
  const stepX = (w - pad * 2) / (vals.length - 1);
  const xy = (v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  };
  const line = vals.map((v, i) => xy(v, i).join(",")).join(" ");
  const dots = vals
    .map((v, i) => {
      const [x, y] = xy(v, i);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" />`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">
    <text x="${pad}" y="16" class="axis-label">input tokens per request (max ${num(max)})</text>
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="axis" />
    <polyline points="${line}" class="line" fill="none" />
    ${dots}
  </svg>`;
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
  const { session, requests, analysis } = await api(
    `/sessions/${encodeURIComponent(id)}`,
  );
  const rows = requests
    .map(
      (r) => `<tr>
      <td><a class="mono" href="#/requests/${encodeURIComponent(r.id)}">${shortId(r.id)}</a></td>
      <td class="mono muted">${dt(r.started_at)}</td>
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
      <th>Request</th><th>Started</th><th>Provider</th><th>Method</th><th>Path</th><th>Status</th>
      <th class="num">Latency</th><th>Model</th><th class="num">In</th><th class="num">Out</th>
      <th>Stop</th><th class="num">Tools</th><th class="num">Cost</th>
    </tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="empty">No requests.</p>`
    }
    <h2>Context growth</h2>
    ${growthChart(analysis.growth)}
    <h2>Context cost</h2>
    ${contextSummary(analysis.context)}
    <h2>Tool usage</h2>
    ${toolBars(analysis.toolUsage)}
    <h2>Repeated tool calls</h2>
    ${repeatedTable(analysis.repeated)}`;
}

function contextSummary(ctx) {
  if (!ctx || !ctx.requests)
    return `<p class="empty">No parsed requests yet — run <code>aap parse</code>.</p>`;
  return `<div class="kv">
      <div class="k">parsed requests</div><div class="v">${num(ctx.requests)}</div>
      <div class="k">system-prompt tokens (resent)</div><div class="v">~${num(ctx.system_tokens_total)}</div>
      <div class="k">tool-definition tokens (resent)</div><div class="v">~${num(ctx.tools_tokens_total)}</div>
    </div>
    <p class="muted">The system prompt and tool definitions are largely static but re-sent on every request — this is the cumulative token cost of that duplication.</p>`;
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
  const toolCalls = r.toolCalls || [];

  app.innerHTML = `
    <div class="crumb"><a href="#/sessions/${encodeURIComponent(r.session_id)}">${shortId(r.session_id)}</a> / ${shortId(r.id)}</div>
    <h2>Request ${shortId(r.id)}</h2>
    <div class="kv">
      <div class="k">provider</div><div class="v">${esc(r.provider)}</div>
      <div class="k">path</div><div class="v">${esc(r.path)}</div>
      <div class="k">started</div><div class="v">${dt(r.started_at)}</div>
      <div class="k">status</div><div class="v">${statusCell(r.status)}</div>
      <div class="k">latency</div><div class="v">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</div>
      <div class="k">model</div><div class="v">${esc(r.model) || "—"}</div>
      <div class="k">tokens</div><div class="v">in ${r.input_tokens ?? "—"} / out ${r.output_tokens ?? "—"}</div>
      <div class="k">messages</div><div class="v">${r.message_count ?? "—"}</div>
      <div class="k">system prompt</div><div class="v">~${num(r.system_tokens ?? 0)} tok</div>
      <div class="k">tools defined</div><div class="v">${r.tools_defined ?? "—"} (~${num(r.tools_tokens ?? 0)} tok)</div>
      <div class="k">stop reason</div><div class="v">${esc(r.stop_reason) || "—"}</div>
      <div class="k">cost</div><div class="v">${cost(r.cost)}</div>
      <div class="k">bytes</div><div class="v">req ${fmtBytes(r.request_bytes)} / resp ${fmtBytes(r.response_bytes)}</div>
    </div>
    <h2>Tool calls (${toolCalls.length})</h2>
    ${toolCallsHtml(toolCalls)}
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

function toolCallsHtml(calls) {
  if (!calls.length)
    return `<p class="empty">No tool calls in this response.</p>`;
  return `<table><thead><tr><th>#</th><th>Tool</th><th>Arguments</th><th class="num">Result (~tok)</th></tr></thead><tbody>${calls
    .map((t, i) => {
      let args = t.arguments || "";
      try {
        if (args) args = JSON.stringify(JSON.parse(args));
      } catch {
        /* leave raw if not valid JSON (e.g. partial stream) */
      }
      const result =
        t.result_tokens != null
          ? `~${num(t.result_tokens)}`
          : '<span class="muted">—</span>';
      return `<tr><td class="num">${i}</td><td>${esc(t.name)}</td><td class="mono">${esc(args) || '<span class="muted">—</span>'}</td><td class="num">${result}</td></tr>`;
    })
    .join("")}</tbody></table>`;
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
