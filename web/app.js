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
const numCompact = (n) => {
  const v = n ?? 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(0) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
};
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
  notification: "notification",
  tool_result: "tool msg",
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

function formatDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  if (ms < 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs === 0) return `${rem}m`;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

async function deleteResource(url, label) {
  if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return false;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return true;
}
window._deleteResource = deleteResource;

function deleteBtn(url, label, small) {
  return `<button class="del-btn${small ? " del-sm" : ""}" onclick="event.stopPropagation();(async()=>{try{if(await window._deleteResource('${esc(url)}','${esc(label)}'))location.reload();}catch(e){alert(e.message)}})()" title="Delete ${esc(label)}">×</button>`;
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

async function decompressResponse(events) {
  const responseEvent = events.find((e) => e.type === "response");
  const encoding = responseEvent?.headers?.["content-encoding"];
  let raw;
  if (!encoding) {
    raw = events
      .filter((e) => e.type === "response_body")
      .map((e) => b64ToText(e.data))
      .join("");
  } else {
    try {
      const chunks = events
        .filter((e) => e.type === "response_body" && e.data)
        .map((e) => {
          const bin = atob(e.data);
          return Uint8Array.from(bin, (c) => c.charCodeAt(0));
        });
      if (chunks.length === 0)
        return `[${encoding}-encoded — run \`aap parse\` for metrics]`;
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const format =
        encoding === "gzip"
          ? "gzip"
          : encoding === "deflate"
            ? "deflate"
            : encoding === "br"
              ? "br"
              : "gzip";
      const ds = new DecompressionStream(format);
      const writer = ds.writable.getWriter();
      writer.write(merged);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } catch {
      return `[${encoding}-encoded — run \`aap parse\` for metrics]`;
    }
  }
  return extractDisplayText(raw);
}

// Parse raw response body (SSE or JSON) into human-readable text.
function extractDisplayText(raw) {
  if (!raw) return "";
  // Anthropic SSE: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
  if (raw.startsWith("event:") || raw.startsWith("data:")) {
    let out = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim());
        if (obj?.delta?.type === "text_delta" && obj.delta.text) {
          out += obj.delta.text;
        }
      } catch {
        /* skip malformed lines */
      }
    }
    if (out) return out;
  }
  // OpenAI / DeepSeek JSON: {"choices":[{"message":{"content":"..."}}]}
  try {
    const obj = JSON.parse(raw);
    const content =
      obj?.choices?.[0]?.message?.content ||
      obj?.choices?.[0]?.text ||
      obj?.content;
    if (typeof content === "string" && content.trim()) return content;
  } catch {
    /* not JSON */
  }
  return raw;
}

async function dashboard() {
  const [stats, sessions, tools, commands, kinds, idleGaps] = await Promise.all(
    [
      api("/stats"),
      api("/sessions"),
      api("/tools"),
      api("/commands"),
      api("/kinds"),
      api("/stats/idle-gaps"),
    ],
  );
  const cacheRate =
    stats.input_tokens > 0
      ? Math.round((stats.cached_input_tokens / stats.input_tokens) * 100)
      : 0;
  const coldRefreshTokens = idleGaps?.coldRefreshTokens || 0;
  const avgIn =
    stats.requests > 0 ? Math.round(stats.input_tokens / stats.requests) : 0;
  const avgCost = stats.sessions > 0 ? stats.cost / stats.sessions : 0;
  const cards = [
    ["Sessions", num(stats.sessions)],
    ["Requests", num(stats.requests)],
    ["Cache hit", `${cacheRate}%`],
    [
      "Input tokens",
      `${numCompact(stats.input_tokens)} · ~${numCompact(avgIn)}/req`,
    ],
    ["Output tokens", numCompact(stats.output_tokens)],
    ["Est. cost", `$${stats.cost.toFixed(2)} · $${avgCost.toFixed(2)}/session`],
  ];

  const topSessions = [...sessions]
    .filter((s) => s.cost > 0 || s.request_count > 0)
    .sort((a, b) => b.cost - a.cost);
  const mostCostly = topSessions[0];
  const mostReqs = [...sessions].sort(
    (a, b) => b.request_count - a.request_count,
  )[0];
  const bestCache = [...sessions]
    .filter((s) => s.input_tokens > 0)
    .sort(
      (a, b) =>
        b.cached_input_tokens / b.input_tokens -
        a.cached_input_tokens / a.input_tokens,
    )[0];

  function topSessionCard(s, label, detail) {
    if (!s) return "";
    const title = s.title || shortId(s.id);
    return `<a class="top-session-card" href="#/sessions/${encodeURIComponent(s.id)}">
      <div class="top-session-label">${label}</div>
      <div class="top-session-title">${esc(title)}</div>
      <div class="top-session-detail muted">${detail}</div>
    </a>`;
  }

  const toolMax = Math.max(...tools.map((t) => t.count), 1);

  const providerCosts = new Map();
  for (const s of sessions) {
    const p = s.client || "unknown";
    providerCosts.set(p, (providerCosts.get(p) || 0) + (s.cost ?? 0));
  }
  const providersArr = [...providerCosts.entries()].sort((a, b) => b[1] - a[1]);
  const maxProviderCost = Math.max(...providersArr.map(([, c]) => c), 1);

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
    <div class="dashboard-grid">
      <div>
        <h2>Top sessions</h2>
        <div class="top-sessions">
          ${topSessionCard(
            mostCostly,
            "Most expensive",
            `${cost(mostCostly?.cost)} · ${num(mostCostly?.request_count || 0)} reqs`,
          )}
          ${topSessionCard(
            mostReqs,
            "Most requests",
            `${cost(mostReqs?.cost)} · ${num(mostReqs?.request_count || 0)} reqs`,
          )}
          ${topSessionCard(
            bestCache,
            "Best cache rate",
            bestCache && bestCache.input_tokens > 0
              ? `${Math.round((bestCache.cached_input_tokens / bestCache.input_tokens) * 100)}% · ${num(bestCache.request_count)} reqs`
              : "",
          )}
        </div>
        <h2>Cache idle gaps</h2>
        ${idleGapsHtml(idleGaps)}
        ${coldRefreshTokens > 0 ? `<p class="muted">~${numCompact(coldRefreshTokens)} tokens written from cold refreshes after gaps &gt;5 min. Reducing gaps (${idleGaps?.globalBuckets?.find((b) => b.bucket === "5m-1h")?.percent || 0}% in 5m-1h + ${idleGaps?.globalBuckets?.find((b) => b.bucket === ">1h")?.percent || 0}% &gt;1h) would lower this.</p>` : ""}
      </div>
      <div>
        <h2>Cost by kind</h2>
        ${kindBreakdownTable(kinds)}
        <h2>Cost by provider</h2>
        ${providerBars(providersArr, maxProviderCost)}
      </div>
    </div>
    <div class="dashboard-subgrid">
      ${
        tools.length > 8
          ? `<div class="collapsible"><h2>Tool usage</h2>${toolBars(tools, toolMax)}</div>`
          : `<div><h2>Tool usage</h2>${toolBars(tools, toolMax)}</div>`
      }
      ${
        commands.length > 8
          ? `<div class="collapsible"><h2>Shell commands</h2>${commandsTable(commands)}</div>`
          : `<div><h2>Shell commands</h2>${commandsTable(commands)}</div>`
      }
    </div>`;
  requestAnimationFrame(() => {
    document.querySelectorAll(".collapsible").forEach((c) => {
      const rows = c.querySelectorAll(".bar-row, table tbody tr");
      if (rows.length <= 8) return;
      const label = c.querySelector(".bars") ? "tool" : "command";
      for (let i = 8; i < rows.length; i++)
        rows[i].classList.add("collapsed-row");
      const btn = document.createElement("button");
      btn.className = "show-toggle";
      btn.textContent = `Show all (${rows.length} ${label}s)`;
      btn.onclick = () => {
        const expanded = c.classList.toggle("expanded");
        btn.textContent = expanded
          ? "Show less"
          : `Show all (${rows.length} ${label}s)`;
      };
      c.appendChild(btn);
    });
  });
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

function toolBars(items, scale) {
  if (!items || !items.length)
    return `<p class="empty">No tool calls recorded. Run <code>aap parse</code>.</p>`;
  const max = scale ?? Math.max(...items.map((t) => t.count), 1);
  return `<div class="bars">${items
    .map((t) => {
      const amp = t.result_tokens
        ? ` · ~${num(t.result_tokens)} result tok`
        : "";
      return `<div class="bar-row"><span class="bar-label mono">${esc(t.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${((t.count / max) * 100).toFixed(1)}%"></span></span><span class="bar-val num">${num(t.count)}${amp}</span></div>`;
    })
    .join("")}</div>`;
}

function providerBars(items, maxCost) {
  if (!items || !items.length) return "";
  return `<div class="bars">${items
    .map(([name, c]) => {
      const pct = ((c / maxCost) * 100).toFixed(1);
      return `<div class="bar-row"><span class="bar-label"><span class="provider-badge provider-${esc(name)}">${esc(name)}</span></span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-val num">${cost(c)}</span></div>`;
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

function cacheBadge(s) {
  if (!s.input_tokens) return "";
  const rate = Math.round((s.cached_input_tokens / s.input_tokens) * 100);
  if (rate === 0) return "";
  const cls =
    rate >= 80 ? "cache-high" : rate >= 40 ? "cache-mid" : "cache-low";
  return `<span class="cache-badge ${cls}">${rate}% cached</span>`;
}

function sessionsRows(sessions) {
  if (!sessions.length) return `<p class="empty">No sessions captured yet.</p>`;
  return sessions
    .map((s) => {
      const title = s.title
        ? `<a class="session-title" href="#/sessions/${encodeURIComponent(s.id)}">${esc(s.title)}</a>`
        : `<a class="session-title mono" href="#/sessions/${encodeURIComponent(s.id)}">${shortId(s.id)}</a>`;
      const summary = s.summary
        ? `<div class="session-summary muted">${esc(s.summary.slice(0, 140))}${s.summary.length > 140 ? "…" : ""}</div>`
        : "";
      const meta = [
        s.client
          ? `<span class="provider-badge provider-${esc(s.client)}">${esc(s.client)}</span>`
          : "",
        s.cwd ? `<span class="mono muted">${esc(s.cwd)}</span>` : "",
        s.last_seen_at
          ? `<span class="muted">${esc(s.last_seen_at.replace("T", " ").slice(0, 16))}</span>`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const duration = formatDuration(s.first_seen_at, s.last_seen_at);
      const badge = cacheBadge(s);
      return `<div class="session-row" onclick="location.href='#/sessions/${encodeURIComponent(s.id)}'">
        <div class="session-info">
          ${title}
          ${summary}
          <div class="session-meta">${meta || '<span class="muted">—</span>'}</div>
        </div>
        <div class="session-stats">
          <span class="stat">${num(s.request_count)} reqs</span>
          ${badge}
          <span class="stat num">${cost(s.cost)}</span>
          <span class="stat muted">${duration}</span>
        </div>
        <div class="session-delete">${deleteBtn(`/sessions/${encodeURIComponent(s.id)}`, `session ${shortId(s.id)}`, true)}</div>
      </div>`;
    })
    .join("");
}

async function sessions() {
  const list = await api("/sessions");
  const filters = {
    provider: "",
    cwd: "",
    minReqs: 0,
    minCached: 0,
    sort: "newest",
  };
  let currentPage = 0;
  const PAGE = 25;

  function applyExcept(except) {
    let filtered = [...list];
    if (except !== "provider" && filters.provider)
      filtered = filtered.filter((s) => s.client === filters.provider);
    if (except !== "cwd" && filters.cwd)
      filtered = filtered.filter((s) => (s.cwd || "(none)") === filters.cwd);
    if (except !== "minReqs" && filters.minReqs > 0)
      filtered = filtered.filter((s) => s.request_count >= filters.minReqs);
    if (except !== "minCached" && filters.minCached > 0)
      filtered = filtered.filter((s) => {
        if (!s.input_tokens) return false;
        return (
          (s.cached_input_tokens / s.input_tokens) * 100 >= filters.minCached
        );
      });
    return filtered;
  }

  function sortedProviders(base) {
    const counts = new Map();
    for (const s of base) {
      if (s.client) counts.set(s.client, (counts.get(s.client) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function sortedCwds(base) {
    const counts = new Map();
    for (const s of base) {
      const cwd = s.cwd || "(none)";
      counts.set(cwd, (counts.get(cwd) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function apply() {
    const filtered = applyExcept(null);
    switch (filters.sort) {
      case "oldest":
        filtered.sort(
          (a, b) =>
            new Date(a.last_seen_at || 0) - new Date(b.last_seen_at || 0),
        );
        break;
      case "most-reqs":
        filtered.sort((a, b) => b.request_count - a.request_count);
        break;
      case "highest-cost":
        filtered.sort((a, b) => b.cost - a.cost);
        break;
      case "highest-cache":
        filtered.sort((a, b) => {
          const ar =
            a.input_tokens > 0 ? a.cached_input_tokens / a.input_tokens : 0;
          const br =
            b.input_tokens > 0 ? b.cached_input_tokens / b.input_tokens : 0;
          return br - ar;
        });
        break;
      default:
        filtered.sort(
          (a, b) =>
            new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0),
        );
    }
    return filtered;
  }

  function renderPage() {
    const filtered = apply();
    const providers = sortedProviders(applyExcept("provider"));
    const cwds = sortedCwds(applyExcept("cwd"));
    const totalPages = Math.ceil(filtered.length / PAGE);
    currentPage = Math.min(currentPage, Math.max(0, totalPages - 1));
    const start = currentPage * PAGE;
    const pageItems = filtered.slice(start, start + PAGE);
    const pagination =
      totalPages > 1
        ? `<div class="pagination" data-target="sessions-page">${Array.from({ length: totalPages }, (_, i) => `<button class="page-btn${i === currentPage ? " active" : ""}" data-page="${i}">${i + 1}</button>`).join("")}</div>`
        : "";

    const changed =
      filtered.length !== list.length
        ? ` <span class="muted">(${filtered.length} shown / ${list.length} total)</span>`
        : "";

    app.innerHTML = `
    <h2>Sessions (${num(list.length)})${changed}</h2>
    <div class="filter-bar">
      <select id="filter-provider">
        <option value="">All providers</option>
        ${providers.map(([p, count]) => `<option value="${esc(p)}"${filters.provider === p ? " selected" : ""}>${esc(p)} (${count})</option>`).join("")}
      </select>
      <select id="filter-cwd">
        <option value="">All directories</option>
        ${cwds.map(([cwd, count]) => `<option value="${esc(cwd)}"${filters.cwd === cwd ? " selected" : ""}>${esc(cwd)} (${count})</option>`).join("")}
      </select>
      <input type="number" id="filter-minreqs" placeholder="Min reqs" value="${filters.minReqs || ""}" min="0" style="width:90px">
      <input type="number" id="filter-mincache" placeholder="Min cache %" value="${filters.minCached || ""}" min="0" max="100" style="width:100px">
      <select id="filter-sort">
        <option value="newest" ${filters.sort === "newest" ? "selected" : ""}>Newest</option>
        <option value="oldest" ${filters.sort === "oldest" ? "selected" : ""}>Oldest</option>
        <option value="most-reqs" ${filters.sort === "most-reqs" ? "selected" : ""}>Most reqs</option>
        <option value="highest-cost" ${filters.sort === "highest-cost" ? "selected" : ""}>Highest cost</option>
        <option value="highest-cache" ${filters.sort === "highest-cache" ? "selected" : ""}>Best cache</option>
      </select>
      <button id="filter-reset" class="btn">Reset</button>
    </div>
    ${pagination}
    ${sessionsRows(pageItems)}
    ${pagination}`;

    document
      .getElementById("filter-provider")
      .addEventListener("change", (e) => {
        filters.provider = e.target.value;
        currentPage = 0;
        renderPage();
      });
    document.getElementById("filter-cwd").addEventListener("change", (e) => {
      filters.cwd = e.target.value;
      currentPage = 0;
      renderPage();
    });
    document.getElementById("filter-minreqs").addEventListener("input", (e) => {
      filters.minReqs = Number(e.target.value) || 0;
      currentPage = 0;
      renderPage();
    });
    document
      .getElementById("filter-mincache")
      .addEventListener("input", (e) => {
        filters.minCached = Number(e.target.value) || 0;
        currentPage = 0;
        renderPage();
      });
    document.getElementById("filter-sort").addEventListener("change", (e) => {
      filters.sort = e.target.value;
      currentPage = 0;
      renderPage();
    });
    document.getElementById("filter-reset").addEventListener("click", () => {
      filters.provider = "";
      filters.cwd = "";
      filters.minReqs = 0;
      filters.minCached = 0;
      filters.sort = "newest";
      currentPage = 0;
      renderPage();
    });
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

function conversationHtml(requests, tcByRequest, chains, regen, selectedId) {
  if (!requests || !requests.length)
    return `<p class="empty">No requests in this session.</p>`;
  const regenMap = regen || {};
  const chainReadIds = new Set((chains || []).map((c) => c.readRequestId));
  const chainSearchIds = new Set((chains || []).map((c) => c.searchRequestId));

  function renderRow(r, i, hidden) {
    const tcs = tcByRequest[r.id] || [];
    const newIn = r.input_tokens ?? 0;
    const cachedIn = r.cached_input_tokens ?? 0;
    const totalIn = newIn + cachedIn;
    const tokensLabel =
      totalIn > 0
        ? `${num(totalIn)} in${cachedIn > 0 ? ` (${num(newIn)} new + ${num(cachedIn)} cached)` : ""} → ${r.output_tokens != null ? num(r.output_tokens) + " out" : "—"}`
        : "—";
    const kind = r.kind || "unknown";
    const rg = regenMap[r.id];
    const ka = r.keep_alive;
    const isSearch = chainSearchIds.has(r.id);
    const isRead = chainReadIds.has(r.id);

    const regenBadge = rg
      ? ` <span class="regen-badge regen-${esc(rg.severity)}" title="${esc(rg.reason)}">cold ▲ ${num(rg.excessTokens)}</span>`
      : "";
    const chainBadge = isSearch
      ? ' <span class="chain-badge chain-search" title="search→read chain: locate step">locate</span>'
      : isRead
        ? ' <span class="chain-badge chain-read" title="search→read chain: read step">read</span>'
        : "";
    const kaBadge = ka ? ' <span class="ka-badge">♻ keep-alive</span>' : "";
    const rowCls = [
      "conv-row",
      selectedId === r.id ? "selected" : "",
      ka ? "keepalive" : "",
      rg ? `regen-${esc(rg.severity)}` : "",
      hidden ? "hidden-child" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const toolPreviews =
      tcs.length > 0
        ? `<div class="conv-tools-inline">${tcs
            .map((tc, j) => {
              const result =
                tc.result_tokens != null
                  ? ` <span class="muted">~${num(tc.result_tokens)} tok</span>`
                  : "";
              return `<span class="conv-tool"><span class="muted">${j + 1}.</span> ${esc(tc.name)}${result}</span>`;
            })
            .join("")}</div>`
        : "";

    const rowMeta = [
      `<span class="conv-seq">#${requests.indexOf(r) + 1}</span>`,
      kindBadge(kind),
      statusCell(r.status),
      `<span class="conv-model mono">${esc(r.model) || "?"}</span>`,
      `<span class="conv-tokens">${tokensLabel}</span>`,
      `<span class="conv-cost num">${cost(r.cost)}</span>`,
      r.latency_ms != null
        ? `<span class="muted">${num(r.latency_ms)}ms</span>`
        : "",
      regenBadge,
      chainBadge,
      kaBadge,
    ]
      .filter(Boolean)
      .join(" ");

    return `<div class="${rowCls}" id="req-${esc(r.id)}" onclick="window._selectRequest('${esc(r.id)}')">
    <div class="conv-row-head">${rowMeta}</div>
    ${toolPreviews}
  </div>`;
  }

  // Group consecutive tool_result and search requests so they render as a
  // single collapsed summary row unless expanded.
  const groupKinds = new Set(["tool_result", "search"]);
  const groups = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const kind = r.kind || "unknown";
    if (!groupKinds.has(kind)) {
      groups.push({ kind: "single", items: [r] });
      continue;
    }
    const group = [];
    while (i < requests.length && (requests[i].kind || "unknown") === kind) {
      group.push(requests[i]);
      i++;
    }
    i--;
    groups.push({ kind: "group", groupKind: kind, items: group });
  }

  const hasGroups = groups.some((g) => g.kind === "group");

  return `<div class="conv-tree">${hasGroups ? `<div class="conv-tree-actions"><button class="btn btn-sm" onclick="document.querySelectorAll('.conv-group').forEach(g => g.open = true)">Expand all</button> <button class="btn btn-sm" onclick="document.querySelectorAll('.conv-group').forEach(g => g.open = false)">Collapse all</button></div>` : ""}${groups
    .map((g) => {
      if (g.kind === "single") {
        return renderRow(g.items[0]);
      }
      const items = g.items;
      const kind = g.groupKind;
      const first = items[0];
      const last = items[items.length - 1];
      const aggCost = items.reduce((s, r) => s + (r.cost ?? 0), 0);
      const aggLatency = items.reduce((s, r) => s + (r.latency_ms ?? 0), 0);
      const aggInput = items.reduce(
        (s, r) => s + (r.input_tokens ?? 0) + (r.cached_input_tokens ?? 0),
        0,
      );
      const aggOutput = items.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
      const allToolNames = new Set();
      for (const r of items) {
        for (const tc of tcByRequest[r.id] || []) allToolNames.add(tc.name);
      }
      const toolList = [...allToolNames].slice(0, 6).join(", ");
      const overflow =
        allToolNames.size > 6 ? ` +${allToolNames.size - 6} more` : "";

      return `<details class="conv-group"${
        items.some((r) => r.id === selectedId) ? " open" : ""
      }>
    <summary class="conv-group-summary">
      <span class="conv-seq">#${requests.indexOf(first) + 1}-${requests.indexOf(last) + 1}</span>
      ${kindBadge(kind)}
      <span class="muted">${items.length} requests</span>
      <span class="conv-model mono">${esc(first.model) || "?"}</span>
      <span class="conv-tokens">${num(aggInput)} in → ${num(aggOutput)} out</span>
      <span class="conv-cost num">${cost(aggCost)}</span>
      <span class="muted">${num(aggLatency)}ms</span>
      <span class="conv-tool" style="font-size:11px">${esc(toolList)}${overflow}</span>
    </summary>
    ${items.map((r) => renderRow(r, requests.indexOf(r), true)).join("")}
  </details>`;
    })
    .join("")}</div>`;
}

function detailPanelHtml(r, stack) {
  const events = r.events || [];
  const responseText = r._responseText ?? "";

  const userMsgs =
    stack && stack.messages
      ? stack.messages.filter((m) => m.role === "user" && !m.toolResultFor)
      : [];
  const lastUserMsg =
    userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;
  const showPrompt = r.kind === "main";
  const searchTaskHtml =
    r.kind === "search" && userMsgs.length > 0
      ? `<h3>Search task</h3><blockquote class="user-prompt"><pre>${esc(userMsgs[0].preview)}</pre></blockquote>`
      : "";
  const userPromptHtml =
    showPrompt && lastUserMsg && lastUserMsg.preview
      ? `<h3>Prompt${userMsgs.length > 1 ? ` (user msg #${lastUserMsg.index + 1} of ${stack.messageCount} total)` : ""}</h3><blockquote class="user-prompt"><pre>${esc(lastUserMsg.preview)}</pre></blockquote>`
      : "";

  const eventLabels = {
    request: "Request sent to provider",
    request_body: "Request body chunk",
    response: "Response headers received",
    response_body: "Response body chunk",
    stream_chunk: "Stream delta",
    error: "Error",
    end: "Request completed",
  };
  const eventTypes = Array.from(new Set(events.map((e) => e.type)));
  const eventFlow =
    eventTypes.length > 0 ? eventTypes.join(" → ") : "no events";

  const eventsHtml =
    events.length > 0
      ? `<details class="events-detail">
      <summary>Events (${events.length}) — flow: ${eventFlow}</summary>
      <div class="mono">${events
        .map((e) => {
          const label = eventLabels[e.type] || e.type;
          const size = e.data ? ` (${e.data.length} b64)` : "";
          const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 23) : "";
          return `<div class="event"><span class="type">${esc(label)}</span> <span class="muted">${ts}</span>${size}</div>`;
        })
        .join("")}</div>
      </details>`
      : "";

  const toolCalls = r.toolCalls || [];
  const totalIn =
    (r.input_tokens ?? 0) +
    (r.cached_input_tokens ?? 0) +
    (r.cache_creation_input_tokens ?? 0);

  const kind = r.kind || "unknown";

  const toolResultMsgs =
    stack && stack.messages
      ? stack.messages.filter((m) => m.toolResultFor || m.role === "tool")
      : [];
  const toolResultDeliveries =
    toolResultMsgs.length > 0
      ? `<details class="delivered-results">
      <summary>Delivered results (${toolResultMsgs.length} tool output${toolResultMsgs.length !== 1 ? "s" : ""})</summary>
      <div class="msg-list">${toolResultMsgs
        .map((m) => {
          const toolName = m.toolCallNames?.[0] || m.toolResultFor || "";
          return `<details class="msg"><summary><span class="pill role-tool">${esc(toolName || "tool")}</span> <span class="num mono">~${num(m.tokens)} tok</span></summary><div class="mono msg-body">${esc(m.preview) || '<span class="muted">(empty)</span>'}</div></details>`;
        })
        .join("")}</div>
      </details>`
      : "";

  const showContextSection = stack && stack.messageCount;
  const contextHtml =
    showContextSection && kind === "main"
      ? `<h3>Context sent (${stack.messageCount} messages)</h3>${messageStackHtml(stack)}`
      : showContextSection
        ? `<details>
    <summary>Context sent (${stack.messageCount} messages)</summary>
    ${messageStackHtml(stack)}
  </details>`
        : "";

  const toolsHtml =
    toolCalls.length > 0
      ? `<h3>Tools (${toolCalls.length})</h3>${toolCallsHtml(toolCalls)}`
      : "";

  const responseLabel =
    kind === "recap"
      ? "Recap"
      : kind === "compact"
        ? "Compacted summary"
        : kind === "title"
          ? "Session title"
          : kind === "search"
            ? "Search results"
            : "Response";
  const responsePreview =
    responseText.length > 0
      ? responseText.length > 10000
        ? `<details><summary>${esc(responseLabel)} (${fmtBytes(responseText.length)})</summary><pre>${esc(responseText)}</pre></details>`
        : `<h3>${esc(responseLabel)}</h3><pre>${esc(responseText)}</pre>`
      : "";

  const isSummaryKind =
    kind === "recap" || kind === "compact" || kind === "title";

  // Search kind: extract grep/glob/read patterns from tool calls
  let searchSummaryHtml = "";
  if (kind === "search" && toolCalls.length > 0) {
    const grepPatterns = [];
    const globPatterns = [];
    const readFiles = [];
    for (const tc of toolCalls) {
      const name = tc.name || "";
      let args = {};
      try {
        if (tc.arguments) args = JSON.parse(tc.arguments);
      } catch {
        /* ignore */
      }
      if (/grep|Grep|rg|search/i.test(name) && args.pattern)
        grepPatterns.push(args.pattern);
      else if (/glob|Glob/i.test(name) && args.pattern)
        globPatterns.push(args.pattern);
      else if (/read|Read|view/i.test(name) && args.file_path)
        readFiles.push(args.file_path);
    }
    const parts = [];
    if (grepPatterns.length)
      parts.push(
        `<span class="muted">grep:</span> ${grepPatterns.map((p) => `<code>${esc(p)}</code>`).join(", ")}`,
      );
    if (globPatterns.length)
      parts.push(
        `<span class="muted">glob:</span> ${globPatterns.map((p) => `<code>${esc(p)}</code>`).join(", ")}`,
      );
    if (readFiles.length)
      parts.push(
        `<span class="muted">files:</span> ${readFiles.map((f) => `<code>${esc(f.slice(-40))}</code>`).join(", ")}`,
      );
    if (parts.length)
      searchSummaryHtml = `<div class="search-summary">${parts.join(" · ")}</div>`;
  }

  return `
    ${userPromptHtml}
    ${searchTaskHtml}
    ${toolResultDeliveries}
    ${isSummaryKind ? responsePreview : ""}
    <div class="kv">
      <div class="k">${kindBadge(r.kind)}</div><div class="v">${esc(r.model) || "—"}</div>
      <div class="k">provider</div><div class="v">${esc(r.provider)}</div>
      <div class="k">path</div><div class="v">${shortPath(r.path)}</div>
      <div class="k">started</div><div class="v">${dt(r.started_at)}</div>
      <div class="k">status</div><div class="v">${statusCell(r.status)}</div>
      <div class="k">latency</div><div class="v">${r.latency_ms == null ? "—" : num(r.latency_ms) + " ms"}</div>
      <div class="k">tokens (in)</div><div class="v">${num(totalIn)}${totalIn > 0 ? ` (${num(r.input_tokens ?? 0)} new + ${num(r.cached_input_tokens ?? 0)} cached${r.cache_creation_input_tokens ? ` + ${num(r.cache_creation_input_tokens)} write` : ""})` : ""}</div>
      <div class="k">tokens (out)</div><div class="v">${r.output_tokens != null ? num(r.output_tokens) : "—"}</div>
      <div class="k">cost</div><div class="v">${cost(r.cost)}</div>
    </div>
    ${searchSummaryHtml}
    ${toolsHtml}
    ${contextHtml}
    ${isSummaryKind ? "" : responsePreview}
    ${eventsHtml}`;
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

  const tcByRequest = {};
  for (const tc of toolCalls || []) {
    (tcByRequest[tc.request_id] = tcByRequest[tc.request_id] || []).push(tc);
  }

  let selectedId = requests[0]?.id || null;
  let selectedDetail = null;
  let selectedStack = null;
  if (selectedId) {
    try {
      [selectedDetail, selectedStack] = await Promise.all([
        api(`/requests/${encodeURIComponent(selectedId)}?events=1`),
        api(`/requests/${encodeURIComponent(selectedId)}/messages`),
      ]);
      if (selectedDetail) {
        selectedDetail._responseText = await decompressResponse(
          selectedDetail.events || [],
        );
      }
    } catch {
      selectedDetail = null;
    }
  }

  function renderDetail() {
    const el = document.getElementById("detail-panel");
    if (!el) return;
    el.innerHTML = selectedDetail
      ? detailPanelHtml(selectedDetail, selectedStack)
      : `<div class="detail-empty"><p class="muted">Select a request to see details</p>
         <div class="cards" style="margin-top:12px">
           <div class="card"><div class="label">Requests</div><div class="value">${num(requests.length)}</div></div>
           <div class="card"><div class="label">Cost</div><div class="value">${cost(requests.reduce((s, r) => s + (r.cost ?? 0), 0))}</div></div>
         </div></div>`;
  }

  window._selectRequest = async function (requestId) {
    selectedId = requestId;
    document
      .querySelectorAll(".conv-row")
      .forEach((r) => r.classList.remove("selected"));
    const row = document.getElementById(`req-${requestId}`);
    if (row) row.classList.add("selected");
    try {
      [selectedDetail, selectedStack] = await Promise.all([
        api(`/requests/${encodeURIComponent(requestId)}?events=1`),
        api(`/requests/${encodeURIComponent(requestId)}/messages`),
      ]);
      if (selectedDetail) {
        selectedDetail._responseText = await decompressResponse(
          selectedDetail.events || [],
        );
      }
    } catch {
      selectedDetail = null;
      selectedStack = null;
    }
    renderDetail();
  };

  const totalCost = requests.reduce((s, r) => s + (r.cost ?? 0), 0);
  const totalInput =
    analysis.context.input_tokens_total +
    analysis.context.cached_input_tokens_total;
  const cacheRate =
    totalInput > 0
      ? Math.round(
          (analysis.context.cached_input_tokens_total / totalInput) * 100,
        )
      : 0;
  const duration = formatDuration(session.first_seen_at, session.last_seen_at);

  app.innerHTML = `
    <div class="crumb"><a href="#/sessions">Sessions</a> / ${shortId(session.id)}</div>
    <h2>${session.title ? esc(session.title) : `Session ${shortId(session.id)}`} ${deleteBtn(`/sessions/${encodeURIComponent(session.id)}`, `session ${shortId(session.id)}`, false)}</h2>
    ${session.summary ? `<blockquote class="session-summary"><pre>${esc(session.summary)}</pre></blockquote>` : ""}
    <div class="cards">
      <div class="card"><div class="label">Cost</div><div class="value">${cost(totalCost)}</div></div>
      <div class="card"><div class="label">Requests</div><div class="value">${num(requests.length)}</div></div>
      <div class="card"><div class="label">Cache</div><div class="value">${cacheRate}%</div></div>
      <div class="card"><div class="label">Duration</div><div class="value">${duration}</div></div>
      ${session.client ? `<div class="card"><div class="label">Client</div><div class="value mono">${esc(session.client)}</div></div>` : ""}
    </div>
    <div class="split-layout">
      <div class="conversation-panel">
        ${conversationHtml(requests, tcByRequest, searchReadChains || [], regenerations, selectedId)}
      </div>
      <div class="detail-panel" id="detail-panel">
        ${selectedDetail ? detailPanelHtml(selectedDetail, selectedStack) : `<div class="detail-empty"><p class="muted">Select a request to see details</p></div>`}
      </div>
    </div>
    <h2>Recommendations</h2>
    ${recommendationsHtml(recommendations)}
    <h2>Cost by kind</h2>
    ${costByKind(requests)}
    <h2>Context growth</h2>
    ${growthChart(analysis.growth)}
    <h2>Context cost</h2>
    ${contextSummary(analysis.context)}
    <h2>Tool usage</h2>
    ${toolBars(analysis.toolUsage)}
    <h2>Shell commands</h2>
    ${commandsTable(commands)}
    <h2>Repeated tool calls</h2>
    ${repeatedTable(analysis.repeated)}`;
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
    "tool_result",
    "search",
    "subagent",
    "guide",
    "webfetch",
    "recap",
    "compact",
    "title",
    "quota",
    "notification",
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
  const responseText = await decompressResponse(events);
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

function idleGapsHtml(result) {
  if (!result || !result.totalGaps)
    return `<p class="empty">No idle gaps to show — need sessions with 2+ requests.</p>`;
  const rows = result.globalBuckets
    .map((b) => {
      const label =
        b.bucket === "<5m"
          ? "&lt;5 min (cache alive)"
          : b.bucket === "5m-1h"
            ? "5 min–1h (1h TTL would help)"
            : "&gt;1h (keep-alive needed)";
      return `<tr><td>${label}</td><td class="num">${b.count}</td><td class="num">${b.percent.toFixed(1)}%</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>Bucket</th><th class="num">Gaps</th><th class="num">%</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">${result.totalGaps} total gaps across ${result.sessionsAnalyzed} session(s). ${result.globalBuckets.find((b) => b.bucket === "5m-1h")?.count || 0} gaps in the 5m–1h window would benefit from a 1h cache TTL upgrade.</p>`;
}
async function introspections() {
  let list;
  try {
    list = await api("/introspections");
  } catch {
    app.innerHTML = `<p class="empty">No introspections yet — run <code>aap intro opencode</code> to start one.</p>`;
    return;
  }
  if (!list || !list.length) {
    app.innerHTML = `<p class="empty">No introspections yet — run <code>aap intro opencode</code> to start one.</p>`;
    return;
  }
  app.innerHTML = `<h2>Introspections (${list.length})</h2>
    <div class="intro-list">${list
      .map((r) => {
        const scope = r.report?.scope || "—";
        const summary = r.report?.summary || "";
        const totalCost = r.report?.cost_profile?.total_cost;
        const badge = r.hasReport
          ? '<span class="pill ok">report</span>'
          : '<span class="pill muted">pending</span>';
        return `<div class="intro-card-wrap">
          <a class="intro-card" href="#/introspections/${encodeURIComponent(r.id)}">
            <div class="intro-card-header">
              <span class="intro-card-date mono">${esc(r.created)}</span>
              ${badge}
            </div>
            <div class="intro-card-scope">${esc(scope)}</div>
            ${summary ? `<div class="intro-card-summary muted">${esc(summary.slice(0, 200))}${summary.length > 200 ? "…" : ""}</div>` : ""}
            ${totalCost != null ? `<div class="intro-card-cost">${cost(totalCost)} total</div>` : ""}
          </a>
          ${deleteBtn(`/introspections/${encodeURIComponent(r.id)}`, `introspection ${esc(r.created)}`, true)}
        </div>`;
      })
      .join("")}</div>`;
}

async function introspectionDetail(id) {
  let report;
  try {
    report = await api(`/introspections/${encodeURIComponent(id)}`);
  } catch (err) {
    app.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
    return;
  }
  const graphs = report?.graphs || {};
  const recs = report?.recommendations || [];
  const tools = report?.tool_insights?.top_tools || report?.tool_insights || [];
  const cp = report?.cost_profile || {};
  const up = report?.usage_profile || {};
  const sh = report?.session_highlights || [];
  const amp = report?.tool_insights?.amplification_concerns || [];

  function sevClass(s) {
    if (s === "high") return "high";
    if (s === "medium") return "warn";
    return "info";
  }

  app.innerHTML = `<div class="crumb"><a href="#/introspections">Introspections</a> / ${esc(id.slice(0, 20))}…</div>
    <h2>Introspection ${esc(report?.scope || id)} ${deleteBtn(`/introspections/${encodeURIComponent(id)}`, `introspection ${esc(id.slice(0, 20))}`, false)}</h2>
    <div class="kv">
      <div class="k">scope</div><div class="v">${esc(report?.scope || "—")}</div>
      <div class="k">summary</div><div class="v">${esc(report?.summary || "—")}</div>
    </div>
    ${
      cp.total_cost != null
        ? `
    <h2>Cost profile</h2>
    <div class="cards">
      <div class="card"><div class="label">Total cost</div><div class="value">${cost(cp.total_cost)}</div></div>
      <div class="card"><div class="label">Avg per session</div><div class="value">${cost(cp.avg_cost_per_session || 0)}</div></div>
      ${cp.median_session_cost != null ? `<div class="card"><div class="label">Median cost</div><div class="value">${cost(cp.median_session_cost)}</div></div>` : ""}
      ${cp.most_expensive_session_cost != null ? `<div class="card"><div class="label">Most expensive</div><div class="value">${cost(cp.most_expensive_session_cost)}</div></div>` : ""}
    </div>`
        : ""
    }
    ${
      up.total_requests != null
        ? `
    <h2>Usage</h2>
    <div class="cards">
      <div class="card"><div class="label">Requests</div><div class="value">${num(up.total_requests)}</div></div>
      <div class="card"><div class="label">Input tokens</div><div class="value">${num(up.total_input_tokens)}</div></div>
      <div class="card"><div class="label">Output tokens</div><div class="value">${num(up.total_output_tokens)}</div></div>
      <div class="card"><div class="label">Tool calls</div><div class="value">${num(up.total_tool_calls)}</div></div>
    </div>`
        : ""
    }
    ${
      graphs.daily_trend
        ? `
    <h2>Daily trend</h2>
    ${timelineChart(graphs.daily_trend)}
    `
        : ""
    }
    ${
      tools.length
        ? `
    <h2>Tool insights</h2>
    <table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Result tokens</th></tr></thead><tbody>
    ${tools.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${num(t.count || t.call_count || 0)}</td><td class="num">~${num(t.result_tokens || 0)}</td></tr>`).join("")}
    </tbody></table>`
        : ""
    }
    ${
      amp.length
        ? `
    <div class="recs" style="margin-top:10px">${amp
      .map(
        (a) =>
          `<div class="rec rec-warn"><span class="rec-sev">amp</span><div class="rec-body"><div class="rec-title">${esc(a.issue || "")}</div><div class="rec-detail muted">${esc(a.suggestion || "")}</div></div></div>`,
      )
      .join("")}</div>`
        : ""
    }
    ${
      sh.length
        ? `
    <h2>Session highlights</h2>
    <table><thead><tr><th>Session</th><th class="num">Reqs</th><th class="num">Cost</th><th class="num">Duration</th><th>Top tool</th><th>Note</th></tr></thead><tbody>
    ${sh
      .map(
        (s) =>
          `<tr><td><a class="mono" href="#/requests/${esc(s.id)}">${shortId(s.id)}</a></td><td class="num">${num(s.requests)}</td><td class="num">${cost(s.cost)}</td><td class="num">${s.duration_minutes != null ? num(s.duration_minutes) + "m" : "—"}</td><td>${esc(s.top_tool || "—")}</td><td class="muted">${esc(s.note || "—")}</td></tr>`,
      )
      .join("")}</tbody></table>`
        : ""
    }
    ${
      graphs.cost_by_project
        ? `
    <h2>Cost by project</h2>
    ${projectBars(graphs.cost_by_project)}
    `
        : ""
    }
    ${
      recs.length
        ? `
    <h2>Recommendations</h2>
    <div class="recs">${recs
      .map((r) => {
        if (typeof r === "string") {
          return `<div class="rec rec-info"><span class="rec-sev">info</span><div class="rec-body"><div class="rec-title">${esc(r)}</div></div></div>`;
        }
        const title = r.title || r.finding || r.summary || "";
        const detail = r.detail || r.suggestion || r.description || "";
        const sev = sevClass(r.severity || r.level || "info");
        return `<div class="rec rec-${sev}"><span class="rec-sev">${esc(r.severity || r.level || "info")}</span><div class="rec-body"><div class="rec-title">${esc(title)}</div>${detail ? `<div class="rec-detail muted">${esc(detail)}</div>` : ""}</div></div>`;
      })
      .join("")}</div>
    `
        : ""
    }
    ${
      graphs.tool_usage
        ? `
    <h2>Tool usage</h2>
    ${toolBars(graphs.tool_usage.map((t) => ({ name: t.tool || t.name, count: t.calls || t.count || 0, result_tokens: t.result_tokens || 0 })))}
    `
        : ""
    }`;
}

function timelineChart(entries) {
  if (!entries || !entries.length)
    return `<p class="empty">No timeline data.</p>`;
  const max = Math.max(...entries.map((e) => e.cost || 0), 1);
  const w = 640;
  const h = 120;
  const pad = 28;
  const stepX = (w - pad * 2) / (entries.length - 1 || 1);
  const xy = (v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  };
  const line = entries.map((e, i) => xy(e.cost || 0, i).join(",")).join(" ");
  const dots = entries
    .map((e, i) => {
      if (!e.cost) return "";
      const [x, y] = xy(e.cost, i);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="dot-write" />`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">
    <text x="${pad}" y="14" class="axis-label">cost per day (max ${cost(max)})</text>
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" class="axis" />
    <polyline points="${line}" class="line line-total" fill="none" />
    ${dots}
  </svg>
  <div class="chart-legend">
    <span class="lg lg-total">cost per day</span>
  </div>`;
}
function projectBars(items) {
  if (!items || !items.length) return `<p class="empty">No project data.</p>`;
  const max = Math.max(...items.map((p) => p.cost || p.total_cost || 0), 0.01);
  return `<div class="bars">${items
    .map((p) => {
      const label = p.project || p.repo || p.cwd || "?";
      const costVal = p.cost || p.total_cost || 0;
      const sessions =
        p.sessions || p.session_count
          ? ` · ${p.sessions || p.session_count} sessions`
          : "";
      return `<div class="bar-row"><span class="bar-label mono">${esc((label || "").slice(0, 40))}</span><span class="bar-track"><span class="bar-fill" style="width:${((costVal / max) * 100).toFixed(1)}%"></span></span><span class="bar-val num">${cost(costVal)}${sessions}</span></div>`;
    })
    .join("")}</div>`;
}

const SEARCH_KINDS = [
  "prompt",
  "response",
  "tool_call",
  "tool_result",
  "title",
  "error",
];
const SEARCH_PAGE_SIZE = 20;

function searchHitHtml(hit, markers) {
  const snippet = esc(hit.snippet)
    .replaceAll(markers.start, "<mark>")
    .replaceAll(markers.end, "</mark>");
  const toolTag = hit.tool_name
    ? ` <span class="pill">${esc(hit.tool_name)}</span>`
    : "";
  const errTag = hit.is_error ? ` <span class="err">error</span>` : "";
  const fileTag = hit.file_path
    ? `<div class="mono muted search-file">${shortPath(hit.file_path, 70)}</div>`
    : "";
  const project = hit.repo || hit.cwd;
  return `<div class="search-hit">
    <div class="search-hit-head">
      <span class="pill">${esc(hit.kind)}</span>${toolTag}${errTag}
      ${hit.provider ? `<span class="muted">${esc(hit.provider)}</span>` : ""}
      <span class="muted">${dt(hit.ts)}</span>
      <span class="mono"><a href="#/sessions/${encodeURIComponent(hit.session_id)}">${shortId(hit.session_id)}</a></span>
      <span class="mono"><a href="#/requests/${encodeURIComponent(hit.request_id)}">req ${shortId(hit.request_id)}</a></span>
      ${project ? `<span class="muted" title="${esc(project)}">${esc(String(project).split("/").pop())}</span>` : ""}
    </div>
    <div class="search-snippet">${snippet}</div>
    ${fileTag}
  </div>`;
}

function facetSelect(id, label, values, selected) {
  const options = ["", ...values]
    .map(
      (v) =>
        `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v) || label}</option>`,
    )
    .join("");
  return `<select id="${id}" title="${label}">${options}</select>`;
}

function searchPagination(page, totalPages) {
  if (totalPages <= 1) return "";
  return `<div class="pagination search-pages">
    <button class="page-btn" data-page="${page - 1}" ${page === 0 ? "disabled" : ""}>‹ prev</button>
    <span class="muted">page ${page + 1} of ${totalPages}</span>
    <button class="page-btn" data-page="${page + 1}" ${page + 1 >= totalPages ? "disabled" : ""}>next ›</button>
  </div>`;
}

async function searchView(hash) {
  const qIdx = hash.indexOf("?");
  const params = new URLSearchParams(qIdx === -1 ? "" : hash.slice(qIdx + 1));
  const q = params.get("q") ?? "";
  const kind = params.get("kind") ?? "";
  const errors = params.get("errors") === "1";
  const file = params.get("file") ?? "";
  const provider = params.get("provider") ?? "";
  const project = params.get("project") ?? "";
  const tool = params.get("tool") ?? "";
  const page = Math.max(parseInt(params.get("page") ?? "0", 10) || 0, 0);

  let status, facets;
  try {
    [status, facets] = await Promise.all([
      api("/search/status"),
      api("/search/facets"),
    ]);
  } catch {
    app.innerHTML = `<h2>Search</h2><p class="empty">Search index is disabled. Enable <code>[search]</code> in config.toml and restart <code>aap serve</code>.</p>`;
    return;
  }

  const kindOptions = ["", ...SEARCH_KINDS]
    .map(
      (k) =>
        `<option value="${k}"${k === kind ? " selected" : ""}>${k || "all kinds"}</option>`,
    )
    .join("");

  const hasFilters = q || errors || file || provider || project || tool || kind;
  let resultsHtml = `<p class="empty">Search everything the proxy has captured: prompts, responses, tool calls, file edits, shell commands, errors.</p>`;
  if (hasFilters) {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (kind) query.set("kind", kind);
    if (errors) query.set("errors", "1");
    if (file) query.set("file", file);
    if (provider) query.set("provider", provider);
    if (project) query.set("project", project);
    if (tool) query.set("tool", tool);
    query.set("limit", String(SEARCH_PAGE_SIZE));
    query.set("offset", String(page * SEARCH_PAGE_SIZE));
    const data = await api(`/search?${query.toString()}`);
    const totalPages = Math.ceil(data.total / SEARCH_PAGE_SIZE);
    const pagination = searchPagination(page, totalPages);
    resultsHtml = data.hits.length
      ? `<p class="muted">${num(data.total)} hit(s)</p>${pagination}` +
        data.hits.map((h) => searchHitHtml(h, data.markers)).join("") +
        pagination
      : `<p class="empty">No matches.</p>`;
  }

  app.innerHTML = `
    <h2>Search</h2>
    <form id="search-form" class="search-form">
      <input type="search" id="search-q" placeholder="e.g. ZMQ port race, NullPointerException, advisory lock…" value="${esc(q)}" />
      <select id="search-kind">${kindOptions}</select>
      ${facetSelect("search-provider", "all providers", facets.providers, provider)}
      ${facetSelect("search-project", "all projects", facets.projects, project)}
      ${facetSelect("search-tool", "all tools", facets.tools, tool)}
      <input type="text" id="search-file" class="search-file-input" placeholder="file filter (e.g. src/store.py)" value="${esc(file)}" />
      <label class="search-errors"><input type="checkbox" id="search-errors"${errors ? " checked" : ""} /> errors only</label>
      <button type="submit">Search</button>
    </form>
    <div id="search-results">${resultsHtml}</div>
    <p class="muted search-status">${num(status.indexedRequests)} requests indexed · ${num(status.chunks)} chunks${status.failedRequests ? ` · ${num(status.failedRequests)} failed` : ""}${status.lastIndexedAt ? ` · last indexed ${dt(status.lastIndexedAt)}` : ""}</p>
  `;

  const navigate = (targetPage) => {
    const next = new URLSearchParams();
    const nq = document.getElementById("search-q").value.trim();
    const nk = document.getElementById("search-kind").value;
    const nf = document.getElementById("search-file").value.trim();
    const ne = document.getElementById("search-errors").checked;
    const np = document.getElementById("search-provider").value;
    const npr = document.getElementById("search-project").value;
    const nt = document.getElementById("search-tool").value;
    if (nq) next.set("q", nq);
    if (nk) next.set("kind", nk);
    if (nf) next.set("file", nf);
    if (ne) next.set("errors", "1");
    if (np) next.set("provider", np);
    if (npr) next.set("project", npr);
    if (nt) next.set("tool", nt);
    if (targetPage > 0) next.set("page", String(targetPage));
    const target = `#/search${next.toString() ? `?${next.toString()}` : ""}`;
    if (location.hash === target) {
      render();
    } else {
      location.hash = target;
    }
  };

  document.getElementById("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    navigate(0);
  });
  for (const sel of [
    "search-kind",
    "search-provider",
    "search-project",
    "search-tool",
  ]) {
    document.getElementById(sel).addEventListener("change", () => navigate(0));
  }
  document.querySelectorAll(".search-pages .page-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(Number(btn.dataset.page));
    });
  });
  if (!hasFilters) document.getElementById("search-q").focus();
}

let currentHash = "/";

async function render() {
  currentHash = location.hash.slice(1) || "/";
  try {
    if (currentHash === "/") return await dashboard();
    if (currentHash === "/sessions") return await sessions();
    if (currentHash === "/search" || currentHash.startsWith("/search?"))
      return await searchView(currentHash);
    const s = currentHash.match(/^\/sessions\/(.+)$/);
    if (s) return await sessionDetail(decodeURIComponent(s[1]));
    const q = currentHash.match(/^\/requests\/(.+)$/);
    if (q) return await requestDetail(decodeURIComponent(q[1]));
    if (currentHash === "/introspections") return await introspections();
    const i = currentHash.match(/^\/introspections\/(.+)$/);
    if (i) return await introspectionDetail(decodeURIComponent(i[1]));
    app.innerHTML = `<p class="empty">Not found.</p>`;
  } catch (err) {
    app.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById("refresh").addEventListener("click", render);
window.addEventListener("hashchange", render);
window.addEventListener("load", render);
