const app = document.getElementById("app");

// --- static-demo shim -------------------------------------------------------
// The live app fetches a small JSON API (/sessions, /requests/:id, ...). For
// the static GitHub Pages build we pre-render each of those responses to a file
// under data/ and map the request path to it with an identical key function.
function fileKey(path) {
  let p = path.replace(/^\//, "");
  p = p.replace(/\?/g, "__q__").replace(/=/g, "-").replace(/&/g, "__");
  p = p.replace(/\//g, "__");
  return "data/" + p + ".json";
}
async function api(path) {
  const url = fileKey(path);
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `${res.status} ${res.statusText} for ${path} (static demo has no data for this view)`,
    );
  return res.json();
}
// ---------------------------------------------------------------------------

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
const shortId = (id) => {
  if (!id) return "—";
  const s = String(id);
  return esc(s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);
};
const shortPath = (p, maxLen = 50) => {
  const full = String(p ?? "");
  if (full.length <= maxLen)
    return `<span title="${esc(full)}">${esc(full)}</span>`;
  return `<span title="${esc(full)}">…${esc(full.slice(full.length - maxLen))}</span>`;
};
const dt = (s) => (s ? esc(String(s).replace("T", " ").slice(0, 19)) : "—");

// Human labels for request kinds (see classifyRequestKind in parse.ts). "main"
// is the user-driven loop; everything else is an agent-initiated call.
const KIND_LABELS = {
  main: "user",
  subagent: "subagent",
  search: "search",
  guide: "guide",
  webfetch: "webfetch",
  title: "title",
  compact: "compact",
  recap: "recap",
  quota: "quota",
  unknown: "?",
};
const kindBadge = (kind) => {
  const k = kind || "unknown";
  const label = KIND_LABELS[k] || k;
  return `<span class="kind-badge kind-${esc(k)}">${esc(label)}</span>`;
};

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
  const [stats, sessions, tools, commands, kinds] = await Promise.all([
    api("/stats"),
    api("/sessions"),
    api("/tools"),
    api("/commands"),
    api("/kinds"),
  ]);
  const cacheRate =
    stats.input_tokens > 0
      ? Math.round((stats.cached_input_tokens / stats.input_tokens) * 100)
      : 0;
  const cards = [
    ["Sessions", num(stats.sessions)],
    ["Requests", num(stats.requests)],
    [
      "Input tokens",
      `${num(stats.input_tokens)}${cacheRate > 0 ? ` <span class="muted">(${cacheRate}% cached)</span>` : ""}`,
    ],
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
    <h2>Cost by kind</h2>
    ${kindBreakdownTable(kinds)}
    <h2>Tool usage</h2>
    ${toolBars(tools)}
    <h2>Shell commands</h2>
    ${commandsTable(commands)}
    <h2>Recent sessions</h2>
    ${sessionsTable(sessions.slice(0, 15))}
  `;
}

// Global cost/token breakdown by request kind, from the /kinds endpoint.
function kindBreakdownTable(kinds) {
  if (!kinds || !kinds.length)
    return `<p class="empty">No parsed requests yet — run <code>aap parse</code>.</p>`;
  const totalCost = kinds.reduce((s, k) => s + (k.cost ?? 0), 0);
  const rows = kinds
    .map((k) => {
      const pct = totalCost > 0 ? Math.round((k.cost / totalCost) * 100) : 0;
      return `<tr>
      <td>${kindBadge(k.kind)}</td>
      <td class="num">${num(k.requests)}</td>
      <td class="num">${num(k.input_tokens)}</td>
      <td class="num">${num(k.output_tokens)}</td>
      <td class="num">${cost(k.cost)}</td>
      <td class="num">${pct}%</td>
    </tr>`;
    })
    .join("");
  const nonUser = kinds
    .filter((k) => k.kind !== "main")
    .reduce((s, k) => s + (k.cost ?? 0), 0);
  const nonUserPct =
    totalCost > 0 ? Math.round((nonUser / totalCost) * 100) : 0;
  return `<table><thead><tr>
      <th>Kind</th><th class="num">Requests</th><th class="num">In</th>
      <th class="num">Out</th><th class="num">Cost</th><th class="num">% cost</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Non-user-triggered calls: ${cost(nonUser)} (${nonUserPct}% of total cost).</p>`;
}

function commandsTable(rows) {
  if (!rows || !rows.length)
    return `<p class="empty">No shell commands captured (run <code>aap parse</code>).</p>`;
  return `<table><thead><tr>
      <th>Command</th><th>Category</th><th class="num">Calls</th><th class="num">Result tokens</th>
    </tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td class="mono">${esc(r.command)}</td><td><span class="pill cat-${esc(r.category)}">${esc(r.category)}</span></td><td class="num">${num(r.count)}</td><td class="num">~${num(r.resultTokens)}</td></tr>`,
      )
      .join("")}</tbody></table>`;
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
  const pts = points || [];
  // Three series: total input = new + cache-read + cache-write; cache read;
  // cache write (spikes on a cold-cache refresh).
  const total = pts.map(
    (p) =>
      (p.input_tokens ?? 0) +
      (p.cached_input_tokens ?? 0) +
      (p.cache_creation_input_tokens ?? 0),
  );
  const read = pts.map((p) => p.cached_input_tokens ?? 0);
  const write = pts.map((p) => p.cache_creation_input_tokens ?? 0);
  if (total.length < 2 || total.every((v) => v === 0))
    return `<p class="empty">Not enough parsed data yet — run <code>aap parse</code>.</p>`;
  const w = 640;
  const h = 160;
  const pad = 28;
  const max = Math.max(...total, 1);
  const stepX = (w - pad * 2) / (total.length - 1);
  const xy = (v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  };
  const poly = (vals, cls) =>
    `<polyline points="${vals.map((v, i) => xy(v, i).join(",")).join(" ")}" class="${cls}" fill="none" />`;
  // Emphasise cache-write points (cold refreshes) with a marker.
  const writeDots = write
    .map((v, i) => {
      if (!v) return "";
      const [x, y] = xy(v, i);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="dot-write" />`;
    })
    .join("");
  const maxWrite = Math.max(...write, 0);
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">
    <text x="${pad}" y="16" class="axis-label">input tokens per request (max ${num(max)})</text>
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="axis" />
    ${poly(total, "line line-total")}
    ${poly(read, "line line-read")}
    ${maxWrite > 0 ? poly(write, "line line-write") : ""}
    ${writeDots}
  </svg>
  <div class="chart-legend">
    <span class="lg lg-total">total input</span>
    <span class="lg lg-read">cache read</span>
    ${maxWrite > 0 ? `<span class="lg lg-write">cache write (cold refresh — max ${num(maxWrite)})</span>` : ""}
  </div>`;
}

function sessionsTable(sessions) {
  if (!sessions.length) return `<p class="empty">No sessions captured yet.</p>`;
  return `<table>
    <thead><tr>
      <th>Session</th><th>Node</th><th>cwd</th>
      <th class="num">Reqs</th><th class="num">In (total)</th><th class="num">Out</th>
      <th class="num">Tools</th><th class="num">Cost</th><th>Last seen</th>
    </tr></thead>
    <tbody>
    ${sessions
      .map((s) => {
        const cacheHint =
          s.cached_input_tokens > 0 && s.input_tokens > 0
            ? ` <span class="muted">(${Math.round((s.cached_input_tokens / s.input_tokens) * 100)}% cached)</span>`
            : "";
        return `<tr>
      <td><a class="mono" href="#/sessions/${encodeURIComponent(s.id)}">${shortId(s.id)}</a></td>
      <td>${esc((s.meta && s.meta.armada_node) || s.client) || "<span class='muted'>—</span>"}</td>
      <td class="mono muted">${esc(s.cwd) || "—"}</td>
      <td class="num">${num(s.request_count)}</td>
      <td class="num">${num(s.input_tokens)}${cacheHint}</td>
      <td class="num">${num(s.output_tokens)}</td>
      <td class="num">${num(s.tool_calls)}</td>
      <td class="num">${cost(s.cost)}</td>
      <td class="mono muted">${esc((s.last_seen_at || "").replace("T", " ").slice(0, 19))}</td>
    </tr>`;
      })
      .join("")}
    </tbody></table>`;
}

async function sessions() {
  const list = await api("/sessions");
  let currentPage = 0;
  const PAGE = 25;
  const totalPages = Math.ceil(list.length / PAGE);

  function renderPage() {
    const start = currentPage * PAGE;
    const pageItems = list.slice(start, start + PAGE);
    const pagination =
      totalPages > 1
        ? `<div class="pagination" data-target="sessions-page">${Array.from({ length: totalPages }, (_, i) => `<button class="page-btn${i === currentPage ? " active" : ""}" data-page="${i}">${i + 1}</button>`).join("")}</div>`
        : "";
    app.innerHTML = `<h2>Sessions (${list.length})</h2>${pagination}${sessionsTable(pageItems)}${pagination}`;
    document
      .querySelectorAll(".pagination[data-target='sessions-page'] .page-btn")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          currentPage = Number(btn.dataset.page);
          renderPage();
        });
      });
  }
  renderPage();
}

const PAGE_SIZE = 50;

function paginatedRequestsTable(requests, page, regenerations) {
  if (!requests.length) return `<p class="empty">No requests.</p>`;
  const regen = regenerations || {};
  const totalPages = Math.ceil(requests.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const pageItems = requests.slice(start, start + PAGE_SIZE);
  const rows = pageItems
    .map((r, idx) => {
      const totalIn = (r.input_tokens ?? 0) + (r.cached_input_tokens ?? 0);
      const inDisplay =
        totalIn > 0
          ? `${num(totalIn)}${r.cached_input_tokens ? ` <span class="muted">(${num(r.cached_input_tokens)} cached)</span>` : ""}`
          : "—";
      const rg = regen[r.id];
      const ka = r.keep_alive;
      const rowCls = ka
        ? ' class="keepalive"'
        : rg
          ? ` class="regen regen-${esc(rg.severity)}"`
          : "";
      const regenCell = rg
        ? `<span class="regen-badge regen-${esc(rg.severity)}" title="${esc(rg.reason)}">cold ▲ ${num(rg.excessTokens)}</span>`
        : "";
      const kaCell = ka ? '<span class="ka-badge">♻ keep-alive</span>' : "";
      const seq = start + idx + 1;
      return `<tr${rowCls}>
      <td class="num muted">${seq}</td>
      <td><a class="mono" href="#/requests/${encodeURIComponent(r.id)}">${shortId(r.id)}</a>${kaCell ? ` ${kaCell}` : ""}</td>
      <td>${kindBadge(r.kind)}</td>
      <td class="mono muted">${dt(r.started_at)}</td>
      <td>${esc(r.provider)}</td>
      <td>${esc(r.method)}</td>
      <td class="mono">${shortPath(r.path)}</td>
      <td>${statusCell(r.status)}</td>
      <td class="num">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</td>
      <td class="mono">${esc(r.model) || "—"}</td>
      <td class="num">${inDisplay}</td>
      <td class="num">${r.output_tokens == null ? "—" : num(r.output_tokens)}</td>
      <td>${esc(r.stop_reason) || "—"}${regenCell ? ` ${regenCell}` : ""}</td>
      <td class="num">${num(r.tool_call_count)}</td>
      <td class="num">${cost(r.cost)}</td>
    </tr>`;
    })
    .join("");
  const pagination =
    totalPages > 1
      ? `<div class="pagination" data-target="requests-page">${Array.from({ length: totalPages }, (_, i) => `<button class="page-btn${i === page ? " active" : ""}" data-page="${i}">${i + 1}</button>`).join("")}</div>`
      : "";
  return `<table><thead><tr>
      <th class="num">#</th>
      <th>Request</th><th>Kind</th><th>Started</th><th>Provider</th><th>Method</th><th>Path</th><th>Status</th>
      <th class="num">Latency</th><th>Model</th><th class="num">In</th><th class="num">Out</th>
      <th>Stop</th><th class="num">Tools</th><th class="num">Cost</th>
    </tr></thead><tbody>${rows}</tbody></table>${pagination}`;
}

async function sessionDetail(id) {
  const [
    {
      session,
      requests,
      analysis,
      recommendations,
      regenerations,
      searchReadChains,
    },
    commands,
    toolCalls,
  ] = await Promise.all([
    api(`/sessions/${encodeURIComponent(id)}`),
    api(`/commands?session=${encodeURIComponent(id)}`),
    api(`/sessions/${encodeURIComponent(id)}/tool-calls`),
  ]);

  let currentPage = 0;

  function renderPage() {
    const el = document.getElementById("requests-container");
    if (el)
      el.innerHTML = paginatedRequestsTable(
        requests,
        currentPage,
        regenerations,
      );
    bindPagination();
  }

  function bindPagination() {
    const btns = document.querySelectorAll(
      ".pagination[data-target='requests-page'] .page-btn",
    );
    btns.forEach((btn) => {
      btn.addEventListener("click", () => {
        currentPage = Number(btn.dataset.page);
        renderPage();
      });
    });
  }

  app.innerHTML = `
    <div class="crumb"><a href="#/sessions">Sessions</a> / ${shortId(session.id)}</div>
    <h2>Session ${shortId(session.id)}</h2>
    <div class="kv">
      <div class="k">id</div><div class="v">${esc(session.id)}</div>
      <div class="k">client</div><div class="v">${esc(session.client) || "—"}</div>
      <div class="k">cwd</div><div class="v">${esc(session.cwd) || "—"}</div>
      <div class="k">repo</div><div class="v">${esc(session.repo) || "—"}</div>
      <div class="k">started</div><div class="v">${esc(session.started_at) || "—"}</div>
      ${
        session.meta
          ? Object.entries(session.meta)
              .map(
                ([k, v]) =>
                  `<div class="k">meta.${esc(k)}</div><div class="v">${esc(v)}</div>`,
              )
              .join("")
          : ""
      }
    </div>
    <h2>Recommendations</h2>
    ${recommendationsHtml(recommendations)}
    <h2>Cost by kind</h2>
    ${costByKind(requests)}
    <h2>Requests (${requests.length})</h2>
    <div id="requests-container">${paginatedRequestsTable(requests, currentPage, regenerations)}</div>
    <h2>Context growth</h2>
    ${growthChart(analysis.growth)}
    <h2>Context cost</h2>
    ${contextSummary(analysis.context)}
    <h2>Tool usage</h2>
    ${toolBars(analysis.toolUsage)}
    <h2>Shell commands</h2>
    ${commandsTable(commands)}
    <h2>Repeated tool calls</h2>
    ${repeatedTable(analysis.repeated)}
    <h2>Conversation tree</h2>
    ${conversationTreeHtml(requests, toolCalls, searchReadChains || [])}`;
  bindPagination();
}

function recommendationsHtml(recs) {
  if (!recs || !recs.length)
    return `<p class="empty">No issues detected (run <code>aap parse</code> first if metrics look empty).</p>`;
  return `<div class="recs">${recs
    .map(
      (r) =>
        `<div class="rec rec-${esc(r.severity)}"><span class="rec-sev">${esc(r.severity)}</span><div class="rec-body"><div class="rec-title">${esc(r.title)}</div><div class="rec-detail muted">${esc(r.detail)}</div></div></div>`,
    )
    .join("")}</div>`;
}

// Break down a session's cost/tokens by request kind, so agent-initiated calls
// (subagents, title-gen, compaction) are visible separately from user turns.
function costByKind(requests) {
  if (!requests || !requests.length) return `<p class="empty">No requests.</p>`;
  const order = [
    "main",
    "search",
    "subagent",
    "guide",
    "webfetch",
    "recap",
    "compact",
    "title",
    "quota",
    "unknown",
  ];
  const agg = {};
  let totalCost = 0;
  for (const r of requests) {
    const k = r.kind || "unknown";
    const a = (agg[k] = agg[k] || { count: 0, cost: 0, inTok: 0, outTok: 0 });
    a.count += 1;
    a.cost += r.cost ?? 0;
    a.inTok += (r.input_tokens ?? 0) + (r.cached_input_tokens ?? 0);
    a.outTok += r.output_tokens ?? 0;
    totalCost += r.cost ?? 0;
  }
  const kinds = Object.keys(agg).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  const rows = kinds
    .map((k) => {
      const a = agg[k];
      const pct = totalCost > 0 ? Math.round((a.cost / totalCost) * 100) : 0;
      return `<tr>
      <td>${kindBadge(k)}</td>
      <td class="num">${num(a.count)}</td>
      <td class="num">${num(a.inTok)}</td>
      <td class="num">${num(a.outTok)}</td>
      <td class="num">${cost(a.cost)}</td>
      <td class="num">${pct}%</td>
    </tr>`;
    })
    .join("");
  const nonUser = kinds
    .filter((k) => k !== "main")
    .reduce((s, k) => s + agg[k].cost, 0);
  const nonUserPct =
    totalCost > 0 ? Math.round((nonUser / totalCost) * 100) : 0;
  return `<table><thead><tr>
      <th>Kind</th><th class="num">Requests</th><th class="num">In</th>
      <th class="num">Out</th><th class="num">Cost</th><th class="num">% cost</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Non-user-triggered calls: ${cost(nonUser)} (${nonUserPct}% of session cost).</p>`;
}

function contextSummary(ctx) {
  if (!ctx || !ctx.requests)
    return `<p class="empty">No parsed requests yet — run <code>aap parse</code>.</p>`;
  const totalInput = ctx.input_tokens_total + ctx.cached_input_tokens_total;
  const cacheRate =
    totalInput > 0
      ? Math.round((ctx.cached_input_tokens_total / totalInput) * 100)
      : 0;
  const cacheRow =
    totalInput > 0
      ? `<div class="k">prompt-cache hit</div><div class="v">${cacheRate}% of input (~${num(ctx.cached_input_tokens_total)} cached / ~${num(totalInput)} total)</div>`
      : "";
  return `<div class="kv">
      <div class="k">parsed requests</div><div class="v">${num(ctx.requests)}</div>
      <div class="k">total input tokens</div><div class="v">~${num(totalInput)} (${num(ctx.input_tokens_total)} new + ${num(ctx.cached_input_tokens_total)} cached)</div>
      <div class="k">system-prompt tokens (resent)</div><div class="v">~${num(ctx.system_tokens_total)}</div>
      <div class="k">tool-definition tokens (resent)</div><div class="v">~${num(ctx.tools_tokens_total)}</div>
      ${cacheRow}
    </div>
    <p class="muted">The system prompt and tool definitions are largely static but re-sent on every request — this is the cumulative token cost of that duplication. Where the provider serves the stable prefix from its prompt cache, that cost is largely offset (see the cache-hit rate above).</p>`;
}

async function requestDetail(id) {
  const [r, stack] = await Promise.all([
    api(`/requests/${encodeURIComponent(id)}?events=1`),
    api(`/requests/${encodeURIComponent(id)}/messages`),
  ]);
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
    <h2>Request ${shortId(r.id)}${r.keep_alive ? ' <span class="ka-badge">♻ keep-alive</span>' : ""}</h2>
    <div class="kv">
      <div class="k">provider</div><div class="v">${esc(r.provider)}</div>
      <div class="k">path</div><div class="v">${shortPath(r.path)}</div>
      <div class="k">started</div><div class="v">${dt(r.started_at)}</div>
      <div class="k">status</div><div class="v">${statusCell(r.status)}</div>
      <div class="k">latency</div><div class="v">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</div>
      <div class="k">model</div><div class="v">${esc(r.model) || "—"}</div>
      <div class="k">tokens</div><div class="v">in ${num((r.input_tokens ?? 0) + (r.cached_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0))} (${num(r.input_tokens ?? 0)} new + ${num(r.cached_input_tokens ?? 0)} cache read${r.cache_creation_input_tokens ? ` + <span class="cache-miss">${num(r.cache_creation_input_tokens)} cache write</span>` : ""}) / out ${r.output_tokens ?? "—"}</div>
      <div class="k">messages</div><div class="v">${r.message_count ?? "—"}</div>
      <div class="k">system prompt</div><div class="v">~${num(r.system_tokens ?? 0)} tok</div>
      <div class="k">tools defined</div><div class="v">${r.tools_defined ?? "—"} (~${num(r.tools_tokens ?? 0)} tok)</div>
      <div class="k">stop reason</div><div class="v">${esc(r.stop_reason) || "—"}</div>
      <div class="k">cost</div><div class="v">${cost(r.cost)}</div>
      <div class="k">bytes</div><div class="v">req ${fmtBytes(r.request_bytes)} / resp ${fmtBytes(r.response_bytes)}</div>
    </div>
    <h2>Tool calls (${toolCalls.length})</h2>
    ${toolCallsHtml(toolCalls)}
    <h2>Context sent (${stack.messageCount} messages)</h2>
    ${messageStackHtml(stack)}
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

function messageStackHtml(stack) {
  if (!stack || !stack.messageCount)
    return `<p class="empty">No request body captured for this request.</p>`;
  const segments = [];
  if (stack.tools.count)
    segments.push({
      role: "tools",
      label: `tools (${stack.tools.count})`,
      bytes: stack.tools.bytes,
      tokens: stack.tools.tokens,
    });
  for (const t of stack.totalsByRole)
    segments.push({
      role: t.role,
      label: `${t.role} (${t.count})`,
      bytes: t.bytes,
      tokens: t.tokens,
    });
  const grandBytes = stack.totalBytes + stack.tools.bytes || 1;
  const bars = segments
    .map((s) => {
      const pct = ((s.bytes / grandBytes) * 100).toFixed(1);
      return `<div class="bar-row"><span class="bar-label mono">${esc(s.label)}</span><span class="bar-track"><span class="bar-fill role-${esc(s.role)}" style="width:${pct}%"></span></span><span class="bar-val num">${fmtBytes(s.bytes)} · ~${num(s.tokens)} tok</span></div>`;
    })
    .join("");
  const rows = stack.messages
    .map((m) => {
      const calls = m.toolCallNames.length
        ? ` <span class="muted">→ ${esc(m.toolCallNames.join(", "))}</span>`
        : "";
      const result = m.toolResultFor
        ? ` <span class="muted">⇐ tool result</span>`
        : "";
      return `<details class="msg"><summary><span class="pill role-${esc(m.role)}">${esc(m.role)}</span> <span class="num mono">${fmtBytes(m.bytes)} · ~${num(m.tokens)} tok</span>${calls}${result}</summary><div class="mono msg-body">${esc(m.preview) || '<span class="muted">(no text content)</span>'}</div></details>`;
    })
    .join("");
  return `<div class="bars">${bars}</div><div class="msg-list">${rows}</div>`;
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

function conversationTreeHtml(requests, toolCalls, chains) {
  if (!requests || !requests.length)
    return `<p class="empty">No requests in this session.</p>`;
  const tcByRequest = {};
  for (const tc of toolCalls || []) {
    (tcByRequest[tc.request_id] = tcByRequest[tc.request_id] || []).push(tc);
  }
  const chainReadIds = new Set((chains || []).map((c) => c.readRequestId));
  const chainSearchIds = new Set((chains || []).map((c) => c.searchRequestId));

  return `<div class="tree">${requests
    .map((r, i) => {
      const tcs = tcByRequest[r.id] || [];
      const hasTools = tcs.length > 0;
      const totalIn = (r.input_tokens ?? 0) + (r.cached_input_tokens ?? 0);
      const kind = r.kind || "unknown";
      const isSearch = chainSearchIds.has(r.id);
      const isRead = chainReadIds.has(r.id);
      const chainBadge = isSearch
        ? ' <span class="chain-badge chain-search" title="search→read chain: locate step">🔍 locate</span>'
        : isRead
          ? ' <span class="chain-badge chain-read" title="search→read chain: read step">📄 read</span>'
          : "";
      const ka = r.keep_alive
        ? ' <span class="ka-badge">♻ keep-alive</span>'
        : "";
      return `<details class="tree-node${hasTools ? " has-tools" : ""}"${hasTools ? "" : ""}>
        <summary class="tree-summary">
          <span class="tree-seq">#${i + 1}</span>
          ${kindBadge(kind)}
          <span class="tree-provider mono">${esc(r.provider)}</span>
          <span class="tree-model mono muted">${esc(r.model) || "?"}</span>
          <span class="tree-tokens num">in ${num(totalIn)} / out ${num(r.output_tokens ?? 0)}</span>
          <span class="tree-cost num">${cost(r.cost)}</span>
          <span class="tree-tools num muted">${tcs.length} tool${tcs.length !== 1 ? "s" : ""}</span>
          ${chainBadge}
          ${ka}
        </summary>
        ${
          hasTools
            ? `<div class="tree-children">${tcs
                .map((tc, j) => {
                  let args = tc.arguments || "";
                  try {
                    if (args) args = JSON.stringify(JSON.parse(args));
                  } catch {
                    /* keep raw */
                  }
                  const maxArgs = 120;
                  const argsDisplay =
                    args.length > maxArgs ? args.slice(0, maxArgs) + "…" : args;
                  return `<div class="tree-tool">
            <span class="tree-tool-num muted">${j + 1}.</span>
            <span class="tree-tool-name mono">${esc(tc.name)}</span>
            <span class="tree-tool-args mono muted">${esc(argsDisplay) || "—"}</span>
            ${tc.result_tokens != null ? `<span class="tree-tool-result num muted">~${num(tc.result_tokens)} tok result</span>` : ""}
          </div>`;
                })
                .join("")}</div>`
            : ""
        }
      </details>`;
    })
    .join("")}</div>`;
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
