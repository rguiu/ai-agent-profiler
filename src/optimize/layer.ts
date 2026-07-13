export interface OptimizeConfig {
  dedup: boolean;
  truncate: boolean;
  stablePrefix: boolean;
  pruneStale: boolean;
  stableTruncate: boolean;
  shapeTestOutput: boolean;
  prefixProbe: boolean;
  frozenCompact: boolean;
  suppressReread: boolean;
  collapseSystem: boolean;
  pruneUnusedTools: boolean;
  insertBreakpoints: boolean;
  reorderVolatile: boolean;
  // Truncate tool results only in the last user message (the growing edge).
  // WARNING: NOT actually prefix-safe. The client re-sends the full (untruncated)
  // result next turn once it moves into mid-history, and tailTruncate only touches
  // the newest message — so it does NOT re-shrink it, causing a cache rebuild from
  // that point. Use stableTruncate (re-applies to every result, every turn) instead.
  // See docs/OPTIMIZATION-STRATEGIES.md (tailTruncate note). Kept for compatibility;
  // the Bedrock default should migrate to stableTruncate once verified.
  tailTruncate: boolean;
  truncateThreshold: number;
  pruneAfterTurns: number;
  suppressWithinTurns: number;
  pruneUnusedToolsAfter: number;
  compactThreshold: number;
  compactKeepTail: number;
  // Batch-prune: suppress further pruning for N turns after a prune event.
  // 0 = prune every turn (old behaviour). Only relevant for prefix-cache
  // providers (DeepSeek) where pruneStale is enabled under cache-safe mode.
  // For explicit-cache providers (Anthropic/Bedrock), pruneStale is disabled
  // entirely — the native cache already achieves ~98% read rate and any prefix
  // editing triggers expensive cache-writes.
  pruneStabilityWindow: number;
  // Tool names to strip from every request from turn 1 onwards.
  // Keeps the prefix stable (no mid-session cache invalidation).
  stripTools: string[];
  // optimizeOnCold: when true, if the gap between requests exceeds cacheTtlMs,
  // temporarily enable all strategies for that single request (the cache write
  // is happening anyway, so shrinking the prefix before it is written is free).
  optimizeOnCold: boolean;
  cacheTtlMs: number;
  // upgradeCacheTtl: rewrite the client's cache_control markers to a 1-hour TTL
  // before forwarding. Claude Code only ever requests the 5m cache; a 1h entry
  // costs 2× input to write (vs 1.25× for 5m) but survives 12× longer, so it
  // wins when idle gaps often fall between 5 min and 1 hour. "off" = passthrough.
  upgradeCacheTtl: "off" | "1h";
}

// Default: only cache-safe strategies active. Prefix-editing strategies are
// retained in code (for optimizeOnCold to fire when the cache is expired anyway)
// but off by default — modifying the cached prefix on Bedrock/DeepSeek destroys
// the native cache and triggers expensive cache-writes. See profiles.ts.
export const DEFAULT_CONFIG: OptimizeConfig = {
  dedup: false,
  truncate: false,
  stablePrefix: false,
  pruneStale: false,
  stableTruncate: false,
  shapeTestOutput: false,
  prefixProbe: false,
  frozenCompact: false,
  suppressReread: false,
  collapseSystem: false,
  pruneUnusedTools: false,
  insertBreakpoints: false,
  reorderVolatile: false,
  tailTruncate: true,
  truncateThreshold: 4096,
  pruneAfterTurns: 6,
  suppressWithinTurns: 2,
  pruneUnusedToolsAfter: 10,
  compactThreshold: 60000,
  compactKeepTail: 20,
  pruneStabilityWindow: 0,
  stripTools: [],
  optimizeOnCold: true,
  // Conservative default: 30 min. Anthropic documents a 5-min *minimum* TTL, but
  // the real expiry is often longer — firing too early would rewrite a still-warm
  // prefix and turn a cheap read into an expensive write. Start high and tighten
  // once real idle-gap/cache-write data (see cache-regen) shows the true TTL.
  cacheTtlMs: 1_800_000, // 30 minutes
  upgradeCacheTtl: "off",
};

// All prefix-editing strategies enabled — applied by optimizeOnCold for the one
// request after the cache has expired. The cache write is unavoidable at that
// point, so shrinking the prefix first is free and makes subsequent reads (for
// the rest of the new TTL window) cheaper.
export const COLD_START_CONFIG: Partial<OptimizeConfig> = {
  dedup: true,
  truncate: true,
  pruneStale: true,
  stableTruncate: true,
  shapeTestOutput: true,
  frozenCompact: true,
  suppressReread: true,
  collapseSystem: true,
  pruneUnusedTools: true,
  tailTruncate: true,
};

// Cache-safe overrides for providers with automatic prefix caching (DeepSeek).
// Deterministic transforms (stableTruncate, shapeTestOutput) produce identical
// bytes for the same input — safe because the cached prefix never shifts.
// prefixProbe is diagnostic-only (no rewrites). See docs/DEEPSEEK-CACHING.md.
export const CACHE_SAFE_OVERRIDES: Partial<OptimizeConfig> = {
  dedup: false,
  truncate: false,
  stablePrefix: false,
  suppressReread: false,
  insertBreakpoints: false,
  reorderVolatile: false,
  collapseSystem: false,
  pruneUnusedTools: false,
  pruneStale: false,
  stableTruncate: true,
  shapeTestOutput: true,
  prefixProbe: true,
  frozenCompact: true,
  tailTruncate: true,
};

export type OptimizeActionType =
  | "dedup"
  | "truncate"
  | "stable_prefix"
  | "prune_stale"
  | "stable_truncate"
  | "shape_test_output"
  | "prefix_break"
  | "frozen_compact"
  | "suppress_reread"
  | "collapse_system"
  | "prune_unused_tools"
  | "strip_tools"
  | "tail_truncate"
  | "insert_breakpoints"
  | "reorder_volatile"
  | "cold_start";

export interface OptimizeAction {
  type: OptimizeActionType;
  turn: number;
  tool?: string;
  tokensSaved: number;
  detail: string;
  cacheRate?: boolean;
}

interface SeenCall {
  turn: number;
  resultHash: string;
  resultTokens: number;
}

interface WriteRecord {
  turn: number;
  path: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashContent(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const sorted = Object.keys(obj)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
    );
  return `{${sorted.join(",")}}`;
}

function extractFilePath(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const fp = parsed.file_path ?? parsed.path ?? parsed.filename;
    return typeof fp === "string" ? fp : null;
  } catch {
    return null;
  }
}

// Deterministic head+tail truncation. Pure function of `content` only, so the
// same input always yields the same output — safe for prefix caching. Returns
// null when the content is too short to be worth truncating.
const TRUNCATION_MARKER = "lines omitted —";

function headTailTruncate(
  content: string,
): { text: string; savedTokens: number } | null {
  const lines = content.split("\n");
  if (lines.length <= 60) return null;
  const head = lines.slice(0, 40).join("\n");
  const tail = lines.slice(-15).join("\n");
  const omitted = lines.length - 55;
  const middleTokens = estimateTokens(lines.slice(40, -15).join("\n"));
  const text = `${head}\n\n[... ${omitted} ${TRUNCATION_MARKER} ${middleTokens} tokens saved ...]\n\n${tail}`;
  return { text, savedTokens: estimateTokens(content) - estimateTokens(text) };
}

const SHAPE_MARKER = "[test output shaped —";

// Deterministic shaping of test/build tool output. Test runners emit mostly
// noise on success: keep failures and summary lines, drop passing spam and ANSI
// escapes, collapse runs of identical lines. Pure function of `content`, so the
// same result shapes to the same bytes every request. Returns null when the
// content isn't test-like or wouldn't save enough.
function shapeTestLog(
  content: string,
): { text: string; savedTokens: number } | null {
  if (content.includes(SHAPE_MARKER)) return null;
  const looksLikeTests =
    /^(ok|not ok)\s+\d+/m.test(content) ||
    /#\s*(tests|pass|fail)\b/.test(content) ||
    /\b(PASS|FAIL|passing|failing)\b/.test(content) ||
    /^Tests:\s/m.test(content);
  if (!looksLikeTests) return null;

  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

  const rawLines = stripAnsi(content).split("\n");
  const kept: string[] = [];
  let droppedPass = 0;
  let prev: string | null = null;
  let dupRun = 0;

  const flushDup = (): void => {
    if (dupRun > 0) {
      kept.push(`[... ${dupRun} identical line(s) collapsed ...]`);
      dupRun = 0;
    }
  };

  for (const line of rawLines) {
    const t = line.trim();
    // Drop passing-test spam ("ok 12 - ...") but always keep failures/todos.
    if (/^ok\s+\d+/.test(t) && !/# (TODO|SKIP)/i.test(t)) {
      droppedPass++;
      continue;
    }
    if (line === prev) {
      dupRun++;
      continue;
    }
    flushDup();
    kept.push(line);
    prev = line;
  }
  flushDup();

  if (droppedPass === 0 && kept.length === rawLines.length) return null;

  const summary =
    droppedPass > 0
      ? `${SHAPE_MARKER} ${droppedPass} passing line(s) omitted, failures kept]`
      : `${SHAPE_MARKER} noise collapsed]`;
  const text = `${kept.join("\n")}\n${summary}`;
  const savedTokens = estimateTokens(content) - estimateTokens(text);
  if (savedTokens <= 20) return null;
  return { text, savedTokens };
}

function summarizeToolResult(
  toolName: string,
  args: string,
  content: string,
): string {
  const lines = content.split("\n").length;
  const tokens = estimateTokens(content);
  const path = extractFilePath(args);
  if (path) {
    const base = path.split("/").pop() ?? path;
    return `[${toolName}: ${base} — ${lines} lines, ~${tokens} tokens]`;
  }
  return `[${toolName}: ${lines} lines, ~${tokens} tokens]`;
}

interface PrefixSnapshot {
  systemHash: string;
  toolsHash: string;
  msgHashes: string[];
  msgTokens: number[];
}

// Structural snapshot of the cacheable regions of a request. Section order in
// the raw JSON doesn't matter — DeepSeek caches identical blocks regardless of
// byte offset — so sections are hashed independently.
function buildPrefixSnapshot(parsed: Record<string, unknown>): PrefixSnapshot {
  const systemStr =
    typeof parsed.system === "string"
      ? parsed.system
      : parsed.system != null
        ? JSON.stringify(parsed.system)
        : "";
  const toolsStr = Array.isArray(parsed.tools)
    ? canonicalJson(parsed.tools)
    : "";
  const messages = Array.isArray(parsed.messages)
    ? (parsed.messages as unknown[])
    : [];
  const msgHashes: string[] = [];
  const msgTokens: number[] = [];
  for (const m of messages) {
    const s = JSON.stringify(m);
    msgHashes.push(hashContent(s));
    msgTokens.push(estimateTokens(s));
  }
  return {
    systemHash: hashContent(systemStr),
    toolsHash: hashContent(toolsStr),
    msgHashes,
    msgTokens,
  };
}

// Index of the first message that differs between snapshots, or the length of
// the shorter list when everything shared is identical (i.e. a pure append).
function firstDivergence(a: PrefixSnapshot, b: PrefixSnapshot): number {
  const n = Math.min(a.msgHashes.length, b.msgHashes.length);
  for (let i = 0; i < n; i++) {
    if (a.msgHashes[i] !== b.msgHashes[i]) return i;
  }
  return n;
}

// Sum of message tokens from index `from` to the end of snapshot `s`.
function tokensAfter(s: PrefixSnapshot, from: number): number {
  let sum = 0;
  for (let i = from; i < s.msgTokens.length; i++) sum += s.msgTokens[i] ?? 0;
  return sum;
}

export class OptimizeLayer {
  // baseConfig is the resolved provider profile; config is the per-request
  // effective config, which optimizeOnCold may temporarily overlay with
  // COLD_START_CONFIG for a single cold request.
  private readonly baseConfig: OptimizeConfig;
  private config: OptimizeConfig;
  private readonly actions: OptimizeAction[] = [];
  private readonly seenCalls = new Map<string, SeenCall>();
  private readonly recentWrites: WriteRecord[] = [];
  private readonly toolsUsed = new Map<string, number>();
  private readonly stableTruncated = new Set<string>();
  private turn = 0;
  private lastToolsJson: string | null = null;
  private lastSystemHash: string | null = null;
  private lastSystemTokens = 0;
  private lastProbeSnapshot: PrefixSnapshot | null = null;
  // Frozen-boundary compaction state: everything before `compactBoundary` is
  // replaced by `frozenSummary` (byte-stable across turns). The boundary only
  // advances when context crosses the threshold again — a rare, deliberate reset.
  private compactBoundary = 0;
  private frozenSummary: string | null = null;
  private markersBeforeOpt = 0;
  private toolDefTokensResent = 0;
  // Batch-prune state: the turn on which the last prune fired. While
  // `turn - lastPruneTurn < pruneStabilityWindow`, pruneStale is suppressed.
  // When pruneStabilityWindow === Infinity, prune fires once then never again.
  private lastPruneTurn = 0;
  // optimizeOnCold state
  private lastRequestAt = 0;
  private _coldStart = false;

  constructor(config: Partial<OptimizeConfig> = {}) {
    this.baseConfig = { ...DEFAULT_CONFIG, ...config };
    this.config = this.baseConfig;
  }

  get isColdStart(): boolean {
    return this._coldStart;
  }

  getActions(): OptimizeAction[] {
    return [...this.actions];
  }

  getTotalTokensSaved(): number {
    return this.actions.reduce((sum, a) => sum + a.tokensSaved, 0);
  }

  getToolDefTokens(): number {
    return this.toolDefTokensResent;
  }

  rewriteRequestBody(body: Buffer): Buffer {
    this.turn++;

    // optimizeOnCold: if the cache TTL has elapsed since the last request, the
    // next request pays a full cache-write regardless — so enable every strategy
    // for this one request to shrink the prefix before it is written.
    const now = Date.now();
    this._coldStart = false;
    if (
      this.baseConfig.optimizeOnCold &&
      this.lastRequestAt > 0 &&
      now - this.lastRequestAt > this.baseConfig.cacheTtlMs
    ) {
      this._coldStart = true;
      this.config = { ...this.baseConfig, ...COLD_START_CONFIG };
      const gapSec = Math.round((now - this.lastRequestAt) / 1000);
      this.actions.push({
        type: "cold_start",
        turn: this.turn,
        tokensSaved: 0,
        detail: `cache expired (${gapSec}s idle > ${this.baseConfig.cacheTtlMs / 1000}s TTL) — full optimization enabled for this request`,
      });
    } else {
      this.config = this.baseConfig;
    }
    this.lastRequestAt = now;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return body;
    }

    let changed = false;

    // Idea C: track tool-def tokens resent each turn
    if (Array.isArray(parsed.tools)) {
      this.toolDefTokensResent += estimateTokens(JSON.stringify(parsed.tools));
    }

    // Snapshot how many cache_control markers the client placed BEFORE we
    // modify anything. Used by insertCacheBreakpoints to restore destroyed ones.
    if (this.config.insertBreakpoints) {
      this.markersBeforeOpt = this.countMarkers(parsed);
    }

    // Idea D: move volatile <system-reminder> blocks to last user message
    if (this.config.reorderVolatile && Array.isArray(parsed.messages)) {
      const reordered = this.reorderVolatileContent(
        parsed.messages as Message[],
      );
      if (reordered) {
        parsed.messages = reordered;
        changed = true;
      }
    }

    // Track the system-prompt hash unconditionally so optimizeOnCold can
    // collapse a repeated prompt even when collapseSystem is normally off.
    if (parsed.system != null) {
      const systemStr =
        typeof parsed.system === "string"
          ? parsed.system
          : JSON.stringify(parsed.system);
      const hash = hashContent(systemStr);
      const tokens = estimateTokens(systemStr);
      if (
        this.config.collapseSystem &&
        this.lastSystemHash === hash &&
        tokens > 100
      ) {
        parsed.system = `[system unchanged — hash:${hash}]`;
        const saved = tokens - estimateTokens(parsed.system as string);
        this.actions.push({
          type: "collapse_system",
          turn: this.turn,
          tokensSaved: saved,
          detail: `collapsed repeated system prompt (~${tokens} → ~${estimateTokens(parsed.system as string)} tokens)`,
        });
        changed = true;
      } else {
        this.lastSystemHash = hash;
        this.lastSystemTokens = tokens;
      }
    }

    // Strip configured tools from every request (stable from turn 1)
    if (this.config.stripTools.length > 0 && Array.isArray(parsed.tools)) {
      const stripped = this.stripConfiguredTools(parsed.tools as ToolDef[]);
      if (stripped) {
        parsed.tools = stripped;
        changed = true;
      }
    }

    // Track tool usage from assistant messages and prune unused tool definitions
    if (
      (this.config.pruneUnusedTools || this.config.stablePrefix) &&
      Array.isArray(parsed.messages)
    ) {
      this.trackToolUsage(parsed.messages as Message[]);
    }

    if (this.config.pruneUnusedTools && Array.isArray(parsed.tools)) {
      const pruned = this.pruneUnusedToolDefs(parsed.tools as ToolDef[]);
      if (pruned) {
        parsed.tools = pruned;
        changed = true;
      }
    }

    if (this.config.stablePrefix && Array.isArray(parsed.tools)) {
      parsed.tools = this.stabiliseTools(parsed.tools as unknown[]);
      changed = true;
    }

    if (this.config.pruneStale && Array.isArray(parsed.messages)) {
      const pruned = this.pruneStaleResults(parsed.messages as Message[]);
      if (pruned) {
        parsed.messages = pruned;
        changed = true;
      }
    }

    if (this.config.frozenCompact && Array.isArray(parsed.messages)) {
      const compacted = this.frozenCompactMessages(
        parsed.messages as Message[],
      );
      if (compacted) {
        parsed.messages = compacted;
        changed = true;
      }
    }

    if (this.config.shapeTestOutput && Array.isArray(parsed.messages)) {
      const shaped = this.shapeTestResults(parsed.messages as Message[]);
      if (shaped) {
        parsed.messages = shaped;
        changed = true;
      }
    }

    if (this.config.stableTruncate && Array.isArray(parsed.messages)) {
      const truncated = this.stableTruncateResults(
        parsed.messages as Message[],
      );
      if (truncated) {
        parsed.messages = truncated;
        changed = true;
      }
    }

    if (this.config.tailTruncate && Array.isArray(parsed.messages)) {
      const truncated = this.tailTruncateResults(parsed.messages as Message[]);
      if (truncated) {
        parsed.messages = truncated;
        changed = true;
      }
    }

    if (this.config.insertBreakpoints) {
      const inserted = this.insertCacheBreakpoints(parsed);
      if (inserted) changed = true;
    }

    // Upgrade cache_control TTL last, after breakpoints are finalised, so every
    // marker (client's + any we added) gets the longer TTL.
    if (this.config.upgradeCacheTtl === "1h") {
      if (this.upgradeCacheControlTtl(parsed)) changed = true;
    }

    const out = changed ? Buffer.from(JSON.stringify(parsed)) : body;
    if (this.config.prefixProbe) this.probePrefix(parsed);
    return out;
  }

  // Rewrite every cache_control marker to a 1-hour TTL. Anthropic accepts
  // `{"type":"ephemeral","ttl":"1h"}`; adding the ttl key is idempotent. Walks
  // system blocks, tool defs, and message content blocks. Returns true if any
  // marker was changed. NOTE: this changes the cached-prefix bytes the first
  // time it runs, so enable it from turn 1 (before the first write) — flipping
  // it mid-session forces one cache miss.
  private upgradeCacheControlTtl(parsed: Record<string, unknown>): boolean {
    let changed = false;
    const bump = (holder: Record<string, unknown> | undefined): void => {
      if (!holder) return;
      const cc = holder.cache_control as Record<string, unknown> | undefined;
      if (cc && cc.type === "ephemeral" && cc.ttl !== "1h") {
        cc.ttl = "1h";
        changed = true;
      }
    };
    if (Array.isArray(parsed.system)) {
      for (const b of parsed.system as Record<string, unknown>[]) bump(b);
    }
    if (Array.isArray(parsed.tools)) {
      for (const t of parsed.tools as Record<string, unknown>[]) bump(t);
    }
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages as Message[]) {
        if (Array.isArray(msg.content)) {
          for (const b of msg.content as Record<string, unknown>[]) bump(b);
        }
      }
    }
    return changed;
  }

  /** Expose action count for debugging. */
  get actionCount(): number {
    return this.actions.length;
  }

  rewriteToolResult(toolName: string, args: string, content: string): string {
    const tokens = estimateTokens(content);

    // Track writes for re-read suppression
    if (this.config.suppressReread) {
      const isWrite =
        /^(write|edit|create|patch)/i.test(toolName) ||
        toolName === "Write" ||
        toolName === "Edit" ||
        toolName === "NotebookEdit";
      if (isWrite) {
        const path = extractFilePath(args);
        if (path) {
          this.recentWrites.push({ turn: this.turn, path });
        }
      }
    }

    // Suppress re-reads: if agent reads a file it just wrote to
    if (this.config.suppressReread) {
      const isRead =
        /^(read|cat|view)/i.test(toolName) ||
        toolName === "Read" ||
        toolName === "View";
      if (isRead) {
        const path = extractFilePath(args);
        if (path && this.wasRecentlyWritten(path)) {
          const stub = `[file just written in turn ${this.lastWriteTurn(path)} — content already known, ~${tokens} tokens suppressed]`;
          const saved = tokens - estimateTokens(stub);
          if (saved > 50) {
            this.actions.push({
              type: "suppress_reread",
              turn: this.turn,
              tool: toolName,
              tokensSaved: saved,
              detail: `suppressed re-read of ${path.split("/").pop()} (written ${this.turn - this.lastWriteTurn(path)!} turns ago)`,
            });
            return stub;
          }
        }
      }
    }

    // Dedup: exact same call + result
    const key = `${toolName}:${args}`;
    const contentHash = hashContent(content);
    if (this.config.dedup) {
      const prev = this.seenCalls.get(key);
      if (prev && prev.resultHash === contentHash) {
        const stub = `[unchanged since turn ${prev.turn}]`;
        const saved = tokens - estimateTokens(stub);
        if (saved > 0) {
          this.actions.push({
            type: "dedup",
            turn: this.turn,
            tool: toolName,
            tokensSaved: saved,
            detail: `${toolName}(${args.slice(0, 60)}) unchanged since turn ${prev.turn}`,
          });
          return stub;
        }
      }
      this.seenCalls.set(key, {
        turn: this.turn,
        resultHash: contentHash,
        resultTokens: tokens,
      });
    }

    // Truncate: large results get head+tail
    if (
      this.config.truncate &&
      content.length > this.config.truncateThreshold
    ) {
      const t = headTailTruncate(content);
      if (t && t.savedTokens > 50) {
        this.actions.push({
          type: "truncate",
          turn: this.turn,
          tool: toolName,
          tokensSaved: t.savedTokens,
          detail: `${toolName} result truncated: ${content.split("\n").length} lines → 55 (saved ~${t.savedTokens} tokens)`,
        });
        return t.text;
      }
    }

    return content;
  }

  private wasRecentlyWritten(path: string): boolean {
    const threshold = this.turn - this.config.suppressWithinTurns;
    return this.recentWrites.some(
      (w) => w.path === path && w.turn >= threshold,
    );
  }

  private lastWriteTurn(path: string): number {
    for (let i = this.recentWrites.length - 1; i >= 0; i--) {
      if (this.recentWrites[i]!.path === path)
        return this.recentWrites[i]!.turn;
    }
    return 0;
  }

  private stabiliseTools(tools: unknown[]): unknown[] {
    const json = canonicalJson(tools);
    const canonical = JSON.parse(json) as unknown[];
    if (this.lastToolsJson !== null && json !== this.lastToolsJson) {
      this.actions.push({
        type: "stable_prefix",
        turn: this.turn,
        tokensSaved: 0,
        detail:
          "tool definitions canonicalised for byte-stable prefix (improves prompt cache hit)",
      });
    }
    this.lastToolsJson = json;
    return canonical;
  }

  private trackToolUsage(messages: Message[]): void {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.name) {
          this.toolsUsed.set(block.name as string, this.turn);
        }
      }
    }
  }

  private pruneUnusedToolDefs(tools: ToolDef[]): ToolDef[] | null {
    if (this.turn <= this.config.pruneUnusedToolsAfter) return null;
    if (this.toolsUsed.size === 0) return null;

    const kept: ToolDef[] = [];
    const pruned: string[] = [];

    for (const tool of tools) {
      const name = tool.name;
      if (!name) {
        kept.push(tool);
        continue;
      }
      if (this.toolsUsed.has(name)) {
        kept.push(tool);
      } else {
        pruned.push(name);
      }
    }

    if (pruned.length === 0) return null;

    const savedTokens =
      estimateTokens(JSON.stringify(tools)) -
      estimateTokens(JSON.stringify(kept));

    this.actions.push({
      type: "prune_unused_tools",
      turn: this.turn,
      tokensSaved: savedTokens,
      detail: `pruned ${pruned.length} unused tool definition(s): ${pruned.slice(0, 5).join(", ")}${pruned.length > 5 ? ` (+${pruned.length - 5} more)` : ""} (~${savedTokens} tokens)`,
    });

    return kept;
  }

  private stripConfiguredTools(tools: ToolDef[]): ToolDef[] | null {
    const stripSet = new Set(this.config.stripTools);
    const kept: ToolDef[] = [];
    const stripped: string[] = [];

    for (const tool of tools) {
      if (tool.name && stripSet.has(tool.name)) {
        stripped.push(tool.name);
      } else {
        kept.push(tool);
      }
    }

    if (stripped.length === 0) return null;

    const savedTokens =
      estimateTokens(JSON.stringify(tools)) -
      estimateTokens(JSON.stringify(kept));

    this.actions.push({
      type: "strip_tools",
      turn: this.turn,
      tokensSaved: savedTokens,
      detail: `stripped ${stripped.length} tool(s): ${stripped.join(", ")} (~${savedTokens} tokens)`,
    });

    return kept;
  }

  private pruneStaleResults(messages: Message[]): Message[] | null {
    const threshold = this.turn - this.config.pruneAfterTurns;
    if (threshold <= 0) return null;

    // Batch-prune: if within the stability window after a previous prune,
    // suppress further pruning so the cache prefix stays byte-stable.
    if (
      this.config.pruneStabilityWindow > 0 &&
      this.lastPruneTurn > 0 &&
      this.turn - this.lastPruneTurn < this.config.pruneStabilityWindow
    ) {
      return null;
    }

    // Track last breakpoint position for cacheRate attribution (observability),
    // but do NOT block pruning — benchmark proved that aggressive pruning
    // dominates cost savings even when it occasionally breaks cached regions.
    let lastBreakpointIdx = -1;
    if (this.config.insertBreakpoints) {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as ContentBlock[]) {
            if (block.cache_control) {
              lastBreakpointIdx = i;
              break;
            }
          }
        }
      }
    }

    let changed = false;
    let msgTurn = 0;
    let msgIdx = -1;
    const result = messages.map((msg) => {
      msgIdx++;
      if (msg.role === "assistant") msgTurn++;
      if (msg.role !== "user" && msg.role !== "tool") return msg;
      if (msgTurn > threshold) return msg;

      if (Array.isArray(msg.content)) {
        const rewritten = msg.content.map((block: ContentBlock) => {
          if (block.type !== "tool_result") return block;
          if (!block.content || typeof block.content !== "string") return block;
          const tokens = estimateTokens(block.content);
          if (tokens < 50) return block;

          const toolUseId = block.tool_use_id as string | undefined;
          const toolName = this.resolveToolName(messages, toolUseId) ?? "tool";
          const summary = summarizeToolResult(toolName, "", block.content);

          changed = true;
          this.actions.push({
            type: "prune_stale",
            turn: this.turn,
            tool: toolName,
            tokensSaved: tokens - estimateTokens(summary),
            detail: `pruned ${toolName} result from turn ${msgTurn} (~${tokens} → ~${estimateTokens(summary)} tokens)`,
            cacheRate:
              this.config.insertBreakpoints &&
              lastBreakpointIdx >= 0 &&
              msgIdx <= lastBreakpointIdx,
          });
          return { ...block, content: summary };
        });
        return { ...msg, content: rewritten };
      }
      // OpenAI format: { role: "tool", content: "..." }
      if (msg.role === "tool" && typeof msg.content === "string") {
        const tokens = estimateTokens(msg.content);
        if (tokens >= 50) {
          const toolCallId = msg.tool_call_id as string | undefined;
          const toolName = this.resolveToolName(messages, toolCallId) ?? "tool";
          const summary = summarizeToolResult(toolName, "", msg.content);
          changed = true;
          this.actions.push({
            type: "prune_stale",
            turn: this.turn,
            tool: toolName,
            tokensSaved: tokens - estimateTokens(summary),
            detail: `pruned ${toolName} result from turn ${msgTurn} (~${tokens} → ~${estimateTokens(summary)} tokens)`,
            cacheRate:
              this.config.insertBreakpoints &&
              lastBreakpointIdx >= 0 &&
              msgIdx <= lastBreakpointIdx,
          });
          return { ...msg, content: summary };
        }
        return msg;
      }
      return msg;
    });
    if (changed) this.lastPruneTurn = this.turn;
    return changed ? result : null;
  }

  // Frozen-boundary compaction. When the accumulated context exceeds
  // `compactThreshold`, fold everything before a boundary into ONE deterministic
  // summary message and keep the most recent `compactKeepTail` messages intact.
  //
  // Cache economics (see docs/DEEPSEEK-CACHING.md §2b): editing the prefix resets
  // the cache for everything after the edit, so we do this RARELY and FREEZE the
  // result. Once a summary covers messages [0..boundary), those exact bytes are
  // re-emitted every turn (no new reset). The boundary only advances when the
  // context crosses the threshold *again* — one deliberate reset amortised over
  // the many turns that follow, which is where long sessions actually win.
  private frozenCompactMessages(messages: Message[]): Message[] | null {
    const msgTokens = messages.map((m) => estimateTokens(JSON.stringify(m)));
    const anchorTokens = msgTokens[0] ?? 0;

    // Size of what we'd actually EMIT with the current frozen boundary applied
    // (anchor + summary + surviving tail). This — not the raw incoming history,
    // which opencode always re-sends in full — is what must stay under the
    // threshold. Gating on the emitted size is what keeps the boundary frozen
    // instead of re-firing every turn.
    const summaryTokens = this.frozenSummary
      ? estimateTokens(this.frozenSummary)
      : 0;
    let tailTokens = 0;
    for (let i = this.compactBoundary; i < msgTokens.length; i++) {
      tailTokens += msgTokens[i] ?? 0;
    }
    const emittedTokens =
      this.compactBoundary > 1
        ? anchorTokens + summaryTokens + tailTokens
        : msgTokens.reduce((a, b) => a + b, 0);

    // First message is typically the system prompt / initial task — never fold
    // index 0; keep the most recent tail intact.
    const tailStart = Math.max(
      0,
      messages.length - this.config.compactKeepTail,
    );

    // Tokens we would NEWLY fold beyond the current boundary. Requiring this to
    // be substantial gives hysteresis: after a compaction the boundary can't
    // advance again until enough fresh content has accrued, so a large fixed
    // anchor+tail can't make it re-fire every turn. A reset is only worth it
    // when it removes a meaningful span (≥ half the threshold).
    let newlyFoldable = 0;
    for (let i = Math.max(1, this.compactBoundary); i < tailStart; i++) {
      newlyFoldable += msgTokens[i] ?? 0;
    }
    const foldFloor = Math.max(
      2000,
      Math.floor(this.config.compactThreshold / 2),
    );

    const needNewBoundary =
      emittedTokens > this.config.compactThreshold &&
      tailStart > this.compactBoundary + 1 &&
      newlyFoldable >= foldFloor;

    if (needNewBoundary) {
      const folded = messages.slice(1, tailStart);
      const foldedTokens = folded.reduce(
        (sum, m) => sum + estimateTokens(JSON.stringify(m)),
        0,
      );
      const roles = folded.reduce<Record<string, number>>((acc, m) => {
        const r = typeof m.role === "string" ? m.role : "unknown";
        acc[r] = (acc[r] ?? 0) + 1;
        return acc;
      }, {});
      const roleStr = Object.entries(roles)
        .map(([r, c]) => `${c} ${r}`)
        .join(", ");
      this.frozenSummary =
        `[earlier conversation compacted — ${folded.length} messages (${roleStr}), ` +
        `~${foldedTokens} tokens omitted. hash:${hashContent(JSON.stringify(folded))}]`;
      this.compactBoundary = tailStart;
      this.actions.push({
        type: "frozen_compact",
        turn: this.turn,
        tokensSaved: foldedTokens - estimateTokens(this.frozenSummary),
        detail: `compacted ${folded.length} messages before index ${tailStart} into one frozen summary (~${foldedTokens} → ~${estimateTokens(this.frozenSummary)} tokens); boundary frozen until emitted context crosses the threshold again`,
      });
    }

    // Apply the current frozen boundary (if any) every turn, byte-identically.
    if (this.frozenSummary === null || this.compactBoundary <= 1) return null;
    if (this.compactBoundary >= messages.length) return null;

    const summaryMsg: Message = { role: "user", content: this.frozenSummary };
    return [messages[0]!, summaryMsg, ...messages.slice(this.compactBoundary)];
  }

  // Cache-safe alternative to pruneStale: truncate large tool results with a
  // transform that depends only on the result content (not its age/position),
  // so every request emits identical bytes for a given result. This shrinks
  // tokens while keeping the prompt prefix byte-stable for DeepSeek's cache.
  // Applied to ALL tool results (regardless of turn), and idempotent: content
  // already carrying the truncation marker is left untouched.
  private stableTruncateResults(messages: Message[]): Message[] | null {
    return this.mapToolResults(messages, (raw, toolName) => {
      if (raw.length <= this.config.truncateThreshold) return null;
      if (raw.includes(TRUNCATION_MARKER)) return null;
      const t = headTailTruncate(raw);
      if (!t || t.savedTokens <= 50) return null;
      // Record each distinct result once, so replayed history doesn't inflate.
      const key = `trunc:${hashContent(raw)}`;
      if (!this.stableTruncated.has(key)) {
        this.stableTruncated.add(key);
        this.actions.push({
          type: "stable_truncate",
          turn: this.turn,
          tool: toolName,
          tokensSaved: t.savedTokens,
          detail: `${toolName} result truncated in place: ${raw.split("\n").length} lines → 55 (saved ~${t.savedTokens} tokens, cache-safe)`,
        });
      }
      return t.text;
    });
  }

  // Cache-safe: shape test/build output deterministically (drop passing-test
  // spam, ANSI, duplicate runs) so the same result maps to the same bytes every
  // request. Runs before stableTruncate so a shaped-but-still-huge log can also
  // be truncated.
  private shapeTestResults(messages: Message[]): Message[] | null {
    return this.mapToolResults(messages, (raw, toolName) => {
      const shaped = shapeTestLog(raw);
      if (!shaped) return null;
      const key = `shape:${hashContent(raw)}`;
      if (!this.stableTruncated.has(key)) {
        this.stableTruncated.add(key);
        this.actions.push({
          type: "shape_test_output",
          turn: this.turn,
          tool: toolName,
          tokensSaved: shaped.savedTokens,
          detail: `${toolName} test output shaped: ${raw.split("\n").length} lines → ${shaped.text.split("\n").length} (saved ~${shaped.savedTokens} tokens, cache-safe)`,
        });
      }
      return shaped.text;
    });
  }

  // Truncate tool results only in the last user message (growing edge).
  // WARNING: the "on subsequent turns the truncated bytes are what's cached" claim
  // is FALSE. The client re-sends the full result next turn (it never learns we
  // edited it); once that result is mid-history this method no longer touches it,
  // so the emitted prefix diverges from the cached one and forces a rebuild. Prefer
  // stableTruncate. See docs/OPTIMIZATION-STRATEGIES.md (tailTruncate note).
  private tailTruncateResults(messages: Message[]): Message[] | null {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;

    const msg = messages[lastUserIdx]!;
    if (!Array.isArray(msg.content)) return null;

    let blockChanged = false;
    const rewritten = msg.content.map((block: ContentBlock) => {
      if (block.type !== "tool_result") return block;
      if (typeof block.content !== "string") return block;
      if (block.content.length <= this.config.truncateThreshold) return block;
      if (block.content.includes(TRUNCATION_MARKER)) return block;
      const t = headTailTruncate(block.content);
      if (!t || t.savedTokens <= 50) return block;
      const toolName =
        this.resolveToolName(messages, block.tool_use_id) ?? "tool";
      this.actions.push({
        type: "tail_truncate",
        turn: this.turn,
        tool: toolName,
        tokensSaved: t.savedTokens,
        detail: `${toolName} tail-truncated: ${block.content.split("\n").length} lines → 55 (saved ~${t.savedTokens} tokens, edge-only)`,
      });
      blockChanged = true;
      return { ...block, content: t.text };
    });

    if (!blockChanged) return null;
    const result = [...messages];
    result[lastUserIdx] = { ...msg, content: rewritten } as Message;
    return result;
  }

  // Walk the messages array applying a content transform to every tool result
  // (OpenAI `role:"tool"` string content and Anthropic `tool_result` blocks).
  // `transform` returns the new content, or null to leave a result unchanged.
  private mapToolResults(
    messages: Message[],
    transform: (content: string, toolName: string) => string | null,
  ): Message[] | null {
    let changed = false;

    const result = messages.map((msg) => {
      if (msg.role !== "user" && msg.role !== "tool") return msg;

      // Anthropic array format: content blocks with tool_result
      if (Array.isArray(msg.content)) {
        let blockChanged = false;
        const rewritten = msg.content.map((block: ContentBlock) => {
          if (block.type !== "tool_result") return block;
          if (typeof block.content !== "string") return block;
          const toolName =
            this.resolveToolName(messages, block.tool_use_id) ?? "tool";
          const out = transform(block.content, toolName);
          if (out === null) return block;
          blockChanged = true;
          return { ...block, content: out };
        });
        if (!blockChanged) return msg;
        changed = true;
        return { ...msg, content: rewritten };
      }

      // OpenAI/DeepSeek format: { role: "tool", content: "..." }
      if (msg.role === "tool" && typeof msg.content === "string") {
        const toolName =
          this.resolveToolName(messages, msg.tool_call_id as string) ?? "tool";
        const out = transform(msg.content, toolName);
        if (out === null) return msg;
        changed = true;
        return { ...msg, content: out };
      }

      return msg;
    });

    return changed ? result : null;
  }

  // Diagnostic: detect genuine prefix-cache regressions. Naive byte-prefix
  // diffing is misleading here because agents like opencode order the payload
  // `messages … tools`, so appending a turn shifts the tools block to a new
  // byte offset even though its content is unchanged — and DeepSeek still serves
  // those moved-but-identical blocks from cache (confirmed against real
  // prompt_cache_miss_tokens). So we compare *structurally*: the system prompt,
  // the tool definitions, and every message EXCEPT the freshly-appended tail.
  // A break is flagged only when a section that was already sent CHANGES
  // content — a real edit — never for pure appends or section reordering.
  private probePrefix(parsed: Record<string, unknown>): void {
    const snapshot = buildPrefixSnapshot(parsed);
    const prev = this.lastProbeSnapshot;
    this.lastProbeSnapshot = snapshot;
    if (prev === null || this.turn <= 1) return;

    const changes: string[] = [];
    if (prev.systemHash !== snapshot.systemHash) changes.push("system");
    if (prev.toolsHash !== snapshot.toolsHash) changes.push("tools");

    // Compare the messages that existed last turn (all but the new tail). Any
    // hash mismatch in that stable region is a real mid-history edit.
    let editedMsgTokens = 0;
    let editedMsgs = 0;
    const stableCount = Math.min(
      prev.msgHashes.length,
      snapshot.msgHashes.length,
    );
    for (let i = 0; i < stableCount; i++) {
      if (prev.msgHashes[i] !== snapshot.msgHashes[i]) {
        editedMsgs++;
        editedMsgTokens += snapshot.msgTokens[i] ?? 0;
      }
    }

    const sectionEdited = changes.length > 0 || editedMsgs > 0;
    if (!sectionEdited) return;

    if (editedMsgs > 0) changes.push(`${editedMsgs} prior message(s)`);
    // Tokens re-billed = the edited section + everything after the FIRST edit
    // point (that's where DeepSeek's prefix match ends).
    const firstEdit = firstDivergence(prev, snapshot);
    const resetTokens = tokensAfter(snapshot, firstEdit) + editedMsgTokens;

    this.actions.push({
      type: "prefix_break",
      turn: this.turn,
      tokensSaved: 0,
      detail: `prefix edited (${changes.join(", ")}) — ~${resetTokens} tokens after the edit point will miss cache`,
    });
  }

  // Insert `cache_control: {type: "ephemeral"}` markers at stable-layer
  // boundaries for Anthropic/Bedrock. Runs AFTER all other optimizations.
  //
  // Strategy: restore + supplement cache coverage.
  //   - `markersBeforeOpt` (set at the top of rewriteRequestBody) records how
  //     many markers the client originally placed.
  //   - After pruneStale / collapseSystem / pruneUnusedTools run, some of those
  //     markers may have been destroyed (the block they lived on was replaced).
  //   - We count what survived, then place new markers at optimal positions up
  //     to: max(originalCount, 3) capped at 4 total.
  //   - This ensures the client's cache intent is preserved even after our edits,
  //     and naive clients (0 markers) get up to 3 for free.
  //
  // Placement priorities (most stable → least):
  //   1. End of system content
  //   2. Last tool definition
  //   3. Second-to-last user message (the context boundary)
  private insertCacheBreakpoints(parsed: Record<string, unknown>): boolean {
    const MAX_BREAKPOINTS = 4;
    const messages = parsed.messages as Message[] | undefined;
    if (!Array.isArray(messages)) return false;

    // Count markers that survived the optimization passes.
    let surviving = 0;
    if (Array.isArray(parsed.system)) {
      for (const b of parsed.system as ContentBlock[]) {
        if (b.cache_control) surviving++;
      }
    }
    if (Array.isArray(parsed.tools)) {
      for (const t of parsed.tools as Array<Record<string, unknown>>) {
        if (t.cache_control) surviving++;
      }
    }
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content as ContentBlock[]) {
          if (b.cache_control) surviving++;
        }
      }
    }

    // Target: at least as many markers as the client originally placed (restore
    // destroyed ones), plus fill up to 3 for naive clients. Never exceed 4.
    const target = Math.min(
      MAX_BREAKPOINTS,
      Math.max(this.markersBeforeOpt, 3),
    );
    let budget = target - surviving;
    if (budget <= 0) return false;

    let placed = 0;

    // Breakpoint 1: system prompt
    if (budget > 0) {
      if (Array.isArray(parsed.system)) {
        const sysBlocks = parsed.system as ContentBlock[];
        if (sysBlocks.length > 0) {
          const last = sysBlocks[sysBlocks.length - 1]!;
          if (!last.cache_control) {
            last.cache_control = { type: "ephemeral" };
            placed++;
            budget--;
          }
        }
      } else if (
        typeof parsed.system === "string" &&
        parsed.system.length > 0
      ) {
        parsed.system = [
          {
            type: "text",
            text: parsed.system,
            cache_control: { type: "ephemeral" },
          },
        ];
        placed++;
        budget--;
      }
    }

    // Breakpoint 2: last tool definition
    if (budget > 0 && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      const tools = parsed.tools as Array<Record<string, unknown>>;
      const lastTool = tools[tools.length - 1]!;
      if (!lastTool.cache_control) {
        lastTool.cache_control = { type: "ephemeral" };
        placed++;
        budget--;
      }
    }

    // Breakpoint 3: second-to-last user message (context boundary)
    if (budget > 0 && messages.length >= 3) {
      let lastUserIdx = -1;
      let secondLastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          if (lastUserIdx === -1) {
            lastUserIdx = i;
          } else {
            secondLastUserIdx = i;
            break;
          }
        }
      }
      if (secondLastUserIdx >= 0) {
        const msg = messages[secondLastUserIdx]!;
        if (Array.isArray(msg.content) && msg.content.length > 0) {
          const lastBlock = msg.content[
            msg.content.length - 1
          ]! as ContentBlock;
          if (!lastBlock.cache_control) {
            lastBlock.cache_control = { type: "ephemeral" };
            placed++;
          }
        }
      }
    }

    if (placed > 0) {
      const destroyed = this.markersBeforeOpt - surviving;
      const detail =
        destroyed > 0
          ? `placed ${placed} breakpoint(s) (${destroyed} destroyed by optimize, ${placed} restored/added)`
          : `placed ${placed} breakpoint(s) — client had none`;
      this.actions.push({
        type: "insert_breakpoints",
        turn: this.turn,
        tokensSaved: 0,
        detail,
      });
    }

    return placed > 0;
  }

  private reorderVolatileContent(messages: Message[]): Message[] | null {
    if (messages.length < 2) return null;

    // Find the last user message index
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return null;

    // Collect volatile blocks from user messages EXCEPT the last one and
    // messages containing tool_result blocks (removing text from those breaks
    // the tool_use→tool_result pairing constraint).
    const movedBlocks: ContentBlock[] = [];
    let movedTokens = 0;
    const result = messages.map((msg, idx) => {
      if (msg.role !== "user" || idx === lastUserIdx) return msg;
      if (!Array.isArray(msg.content)) return msg;
      const hasToolResult = (msg.content as ContentBlock[]).some(
        (b) => b.type === "tool_result",
      );
      if (hasToolResult) return msg;

      const kept: ContentBlock[] = [];
      let msgChanged = false;
      for (const block of msg.content as ContentBlock[]) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          (block.text as string).startsWith("<system-reminder>")
        ) {
          movedBlocks.push(block);
          movedTokens += estimateTokens(block.text as string);
          msgChanged = true;
        } else {
          kept.push(block);
        }
      }
      if (!msgChanged) return msg;
      if (kept.length === 0)
        return { ...msg, content: [{ type: "text", text: "" }] };
      return { ...msg, content: kept };
    });

    if (movedBlocks.length === 0) return null;

    // Don't inject into a message that contains tool_results (breaks API constraints)
    const lastMsg = result[lastUserIdx]!;
    const lastContent = Array.isArray(lastMsg.content)
      ? (lastMsg.content as ContentBlock[])
      : typeof lastMsg.content === "string"
        ? [{ type: "text", text: lastMsg.content } as ContentBlock]
        : [];
    const lastHasToolResult = lastContent.some((b) => b.type === "tool_result");
    if (lastHasToolResult) return null;

    result[lastUserIdx] = {
      ...lastMsg,
      content: [...movedBlocks, ...lastContent],
    };

    this.actions.push({
      type: "reorder_volatile",
      turn: this.turn,
      tokensSaved: 0,
      detail: `moved ${movedBlocks.length} <system-reminder> block(s) (~${movedTokens} tokens) to last user message for prefix stability`,
    });

    return result;
  }

  private countMarkers(parsed: Record<string, unknown>): number {
    let count = 0;
    if (Array.isArray(parsed.system)) {
      for (const b of parsed.system as ContentBlock[]) {
        if (b.cache_control) count++;
      }
    }
    if (Array.isArray(parsed.tools)) {
      for (const t of parsed.tools as Array<Record<string, unknown>>) {
        if (t.cache_control) count++;
      }
    }
    const messages = parsed.messages as Message[] | undefined;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (Array.isArray(msg.content)) {
          for (const b of msg.content as ContentBlock[]) {
            if (b.cache_control) count++;
          }
        }
      }
    }
    return count;
  }

  private resolveToolName(
    messages: Message[],
    toolCallId?: string,
  ): string | null {
    if (!toolCallId) return null;
    for (const msg of messages) {
      // OpenAI format: { role: "assistant", tool_calls: [{ id, function: { name } }] }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          if (tc.id === toolCallId && tc.function) {
            return (
              ((tc.function as Record<string, unknown>).name as string) ?? null
            );
          }
        }
      }
      // Anthropic format: { role: "assistant", content: [{ type: "tool_use", id, name }] }
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id === toolCallId) {
            return (block.name as string) ?? null;
          }
        }
      }
    }
    return null;
  }
}

interface ContentBlock {
  type: string;
  content?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}

interface ToolDef {
  name?: string;
  [key: string]: unknown;
}
