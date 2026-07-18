// Read-only analysis of Claude Code's session transcript JSONL.
//
// Claude Code stores each session at
//   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
// as one JSON *event* per line. The events form a TREE via parentUuid → uuid,
// not a flat log: rewind/edit/checkpoint create abandoned side branches. The
// real conversation is the path from the newest leaf back to the root, so we
// must walk parent pointers — reading lines top-to-bottom would include dead
// branches.
//
// Only `user` and `assistant` events carry an API `message`; everything else
// (attachment, system, mode, file-history-snapshot, …) is UI/metadata never
// sent to the model. A tool call spans an assistant(tool_use) event and a
// later user(tool_result) event; the two must stay paired.
//
// This module is READ-ONLY. It never writes to the transcript. It reconstructs
// the message array and reports what compaction *would* save — no mutation.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../cache/common-prefix.js";

// Raw event as stored on one JSONL line. Only the fields we use are typed;
// the rest are preserved opaquely.
export interface TranscriptEvent {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: TranscriptUsage;
    model?: string;
  };
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  [key: string]: unknown;
}

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// A single API-visible message (user or assistant) on the active path.
export interface ReconstructedMessage {
  role: string;
  content: unknown;
  uuid: string;
  isCompactSummary: boolean;
  usage?: TranscriptUsage;
  timestamp?: string;
  model?: string;
}

export interface ToolResultInfo {
  toolName: string | null;
  toolUseId: string;
  bytes: number;
  tokens: number;
  messageUuid: string;
}

export interface ParsedTranscript {
  path: string;
  sessionId: string | null;
  cwd: string | null;
  totalEvents: number;
  chainedEvents: number;
  activePathEvents: number;
  abandonedEvents: number;
  leafCount: number;
  branchPoints: number;
  eventTypeCounts: Record<string, number>;
  messages: ReconstructedMessage[];
}

// Convert an absolute cwd to Claude's project-dir slug: every "/" and "." → "-".
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function claudeProjectsDir(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

// Locate a transcript. Accepts either a path to a .jsonl file, a bare
// session UUID (searched across all project dirs), or a UUID scoped to the
// given cwd. Returns the resolved absolute path or null.
export function locateTranscript(
  idOrPath: string,
  opts: { cwd?: string; home?: string } = {},
): string | null {
  const home = opts.home ?? homedir();
  if (idOrPath.endsWith(".jsonl")) {
    try {
      statSync(idOrPath);
      return idOrPath;
    } catch {
      return null;
    }
  }

  const root = claudeProjectsDir(home);
  const target = `${idOrPath}.jsonl`;

  // Prefer the cwd-scoped project dir when a cwd is supplied.
  if (opts.cwd) {
    const scoped = join(root, projectSlug(opts.cwd), target);
    try {
      statSync(scoped);
      return scoped;
    } catch {
      // fall through to a global scan
    }
  }

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(root, dir, target);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

// Find the newest transcript for a cwd (the session most recently written).
export function newestTranscriptFor(
  cwd: string,
  home: string = homedir(),
): string | null {
  const dir = join(claudeProjectsDir(home), projectSlug(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const p = join(dir, e);
    const mtime = statSync(p).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
  }
  return newest?.path ?? null;
}

function parseEvents(raw: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TranscriptEvent);
    } catch {
      // Skip malformed lines rather than aborting — a truncated final write
      // is common while a session is live.
    }
  }
  return events;
}

// Walk the tree: from the newest event that has a uuid, follow parentUuid back
// to the root. Returns the active-path events in conversation order (root →
// leaf). Events without a uuid (pure metadata) are ignored for pathing.
function activePath(events: TranscriptEvent[]): TranscriptEvent[] {
  const byUuid = new Map<string, TranscriptEvent>();
  for (const e of events) {
    if (e.uuid) byUuid.set(e.uuid, e);
  }
  if (byUuid.size === 0) return [];

  // Newest leaf = the last chained event in file order.
  //
  // ASSUMPTION (not fully verified): the active conversation ends at the last
  // physical line with a uuid. This holds when Claude only ever appends. After a
  // rewind/edit, Claude writes new events onto a branch off an earlier node — if
  // it appends those to the end of the file (observed here), the last line is
  // still the active leaf. DOUBT: if a resumed/rewound session can leave a
  // higher-timestamp event on an *abandoned* branch as the physical last line,
  // this picks the wrong leaf. A more robust rule would pick the leaf with the
  // newest `timestamp`, or the deepest leaf. Revisit if abandoned-branch counts
  // look wrong on real files.
  let leaf: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.uuid) {
      leaf = events[i]!.uuid;
      break;
    }
  }

  const reversed: TranscriptEvent[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leaf;
  while (cur && byUuid.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node: TranscriptEvent = byUuid.get(cur)!;
    reversed.push(node);
    cur = node.parentUuid ?? null;
  }
  return reversed.reverse();
}

export function parseTranscript(path: string): ParsedTranscript {
  const raw = readFileSync(path, "utf8");
  const events = parseEvents(raw);

  const eventTypeCounts: Record<string, number> = {};
  const byUuid = new Map<string, TranscriptEvent>();
  const parents = new Set<string | null | undefined>();
  const childCounts = new Map<string | null | undefined, number>();
  for (const e of events) {
    eventTypeCounts[e.type] = (eventTypeCounts[e.type] ?? 0) + 1;
    if (e.uuid) byUuid.set(e.uuid, e);
    parents.add(e.parentUuid);
    childCounts.set(e.parentUuid, (childCounts.get(e.parentUuid) ?? 0) + 1);
  }

  const chained = events.filter((e) => e.uuid);
  const leafCount = chained.filter((e) => !parents.has(e.uuid)).length;
  let branchPoints = 0;
  for (const [, count] of childCounts) if (count > 1) branchPoints++;

  const path_ = activePath(events);
  const messages: ReconstructedMessage[] = [];
  for (const e of path_) {
    if ((e.type === "user" || e.type === "assistant") && e.message) {
      messages.push({
        role: e.message.role ?? e.type,
        content: e.message.content,
        uuid: e.uuid!,
        isCompactSummary: e.isCompactSummary === true,
        usage: e.message.usage,
        timestamp: typeof e.timestamp === "string" ? e.timestamp : undefined,
        model:
          typeof e.message.model === "string" ? e.message.model : undefined,
      });
    }
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  for (const e of events) {
    if (sessionId === null && typeof e.sessionId === "string") {
      sessionId = e.sessionId;
    }
    if (cwd === null && typeof e.cwd === "string") cwd = e.cwd;
    if (sessionId !== null && cwd !== null) break;
  }

  return {
    path,
    sessionId,
    cwd,
    totalEvents: events.length,
    chainedEvents: chained.length,
    activePathEvents: path_.length,
    abandonedEvents: chained.length - path_.length,
    leafCount,
    branchPoints,
    eventTypeCounts,
    messages,
  };
}

// ---- Analysis over the reconstructed message array ----

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") return JSON.stringify(b);
        return "";
      })
      .join("");
  }
  return "";
}

// Extract every tool_result block on the active path, with its size.
export function toolResults(
  messages: ReconstructedMessage[],
): ToolResultInfo[] {
  const out: ToolResultInfo[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_result"
      ) {
        const b = block as {
          tool_use_id?: string;
          content?: unknown;
          name?: string;
        };
        const text = contentToString(b.content);
        // DOUBT: in the Anthropic block format a `tool_result` does NOT normally
        // carry a `name` — the tool name lives on the matching `tool_use` block.
        // We read `b.name` opportunistically in case Claude's transcript adds it,
        // but the reliable attribution is via toolUseNames() (tool_use_id → name),
        // which callers apply. `toolName` here is usually null; don't rely on it.
        out.push({
          toolName: b.name ?? null,
          toolUseId: b.tool_use_id ?? "",
          bytes: Buffer.byteLength(text, "utf8"),
          tokens: estimateTokens(text),
          messageUuid: m.uuid,
        });
      }
    }
  }
  return out;
}

// Map tool_use ids → tool name so tool_results can be attributed to a tool.
export function toolUseNames(
  messages: ReconstructedMessage[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use"
      ) {
        const b = block as { id?: string; name?: string };
        if (b.id && b.name) names.set(b.id, b.name);
      }
    }
  }
  return names;
}

export interface TranscriptStats {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  estimatedTokens: number;
  // Cache accounting pulled straight from assistant usage fields (ground truth
  // from the provider, not an estimate).
  reportedCacheReadTokens: number;
  reportedCacheCreationTokens: number;
  toolResultCount: number;
  toolResultTokens: number;
  // Per-tool token totals from tool_result content, keyed by tool name.
  tokensByTool: Record<string, number>;
  largestResults: ToolResultInfo[];
}

export function computeStats(t: ParsedTranscript): TranscriptStats {
  const results = toolResults(t.messages);
  const names = toolUseNames(t.messages);

  let estimatedTokens = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let reportedCacheReadTokens = 0;
  let reportedCacheCreationTokens = 0;
  for (const m of t.messages) {
    estimatedTokens += estimateTokens(contentToString(m.content));
    if (m.role === "user") userMessages++;
    else if (m.role === "assistant") assistantMessages++;
    if (m.usage) {
      reportedCacheReadTokens += m.usage.cache_read_input_tokens ?? 0;
      reportedCacheCreationTokens += m.usage.cache_creation_input_tokens ?? 0;
    }
  }

  const tokensByTool: Record<string, number> = {};
  let toolResultTokens = 0;
  for (const r of results) {
    const name = r.toolName ?? names.get(r.toolUseId) ?? "(unknown)";
    tokensByTool[name] = (tokensByTool[name] ?? 0) + r.tokens;
    toolResultTokens += r.tokens;
  }

  const largestResults = [...results]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10)
    .map((r) => ({
      ...r,
      toolName: r.toolName ?? names.get(r.toolUseId) ?? null,
    }));

  return {
    messageCount: t.messages.length,
    userMessages,
    assistantMessages,
    estimatedTokens,
    reportedCacheReadTokens,
    reportedCacheCreationTokens,
    toolResultCount: results.length,
    toolResultTokens,
    tokensByTool,
    largestResults,
  };
}

export interface SavingsProjection {
  strategy: string;
  description: string;
  tokensSaved: number;
  detail: string;
}

// Project — read-only, never applied — what each compaction strategy WOULD
// save if the transcript were rewritten and re-sent by Claude on resume.
export function projectSavings(
  t: ParsedTranscript,
  opts: { truncateThreshold?: number; stripTools?: string[] } = {},
): SavingsProjection[] {
  const thresholdTokens = Math.ceil((opts.truncateThreshold ?? 4096) / 4);
  const results = toolResults(t.messages);
  const names = toolUseNames(t.messages);
  const projections: SavingsProjection[] = [];

  // stableTruncate: cap oversized tool results at the threshold.
  let truncSaved = 0;
  let truncCount = 0;
  for (const r of results) {
    if (r.tokens > thresholdTokens) {
      truncSaved += r.tokens - thresholdTokens;
      truncCount++;
    }
  }
  projections.push({
    strategy: "stableTruncate",
    description: "truncate oversized tool results deterministically",
    tokensSaved: truncSaved,
    detail: `${truncCount} results over ${thresholdTokens} tokens`,
  });

  // dedup: identical tool_result content bodies repeated on the active path.
  const contentSeen = new Map<string, number>();
  let dedupSaved = 0;
  let dedupCount = 0;
  for (const m of t.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_result"
      ) {
        const text = contentToString((block as { content?: unknown }).content);
        if (text.length < 200) continue;
        const prior = contentSeen.get(text) ?? 0;
        if (prior > 0) {
          dedupSaved += estimateTokens(text);
          dedupCount++;
        }
        contentSeen.set(text, prior + 1);
      }
    }
  }
  projections.push({
    strategy: "dedup",
    description: "collapse identical repeated tool results to stubs",
    tokensSaved: dedupSaved,
    detail: `${dedupCount} duplicate results`,
  });

  // stripTools: remove named tools' result content entirely (e.g. tools we
  // rarely use like Workflow). Also counts the results that reference them.
  if (opts.stripTools && opts.stripTools.length > 0) {
    const strip = new Set(opts.stripTools);
    let stripSaved = 0;
    let stripCount = 0;
    for (const r of results) {
      const name = r.toolName ?? names.get(r.toolUseId) ?? "";
      if (strip.has(name)) {
        stripSaved += r.tokens;
        stripCount++;
      }
    }
    projections.push({
      strategy: "stripTools",
      description: `drop content for tools: ${opts.stripTools.join(", ")}`,
      tokensSaved: stripSaved,
      detail: `${stripCount} results from stripped tools`,
    });
  }

  return projections;
}
