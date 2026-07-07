export interface OptimizeConfig {
  dedup: boolean;
  truncate: boolean;
  stablePrefix: boolean;
  pruneStale: boolean;
  suppressReread: boolean;
  collapseSystem: boolean;
  stripToolDefs: boolean;
  pruneUnusedTools: boolean;
  truncateThreshold: number;
  pruneAfterTurns: number;
  suppressWithinTurns: number;
  stripToolDefsAfter: number;
  pruneUnusedToolsAfter: number;
}

export const DEFAULT_CONFIG: OptimizeConfig = {
  dedup: true,
  truncate: true,
  stablePrefix: true,
  pruneStale: true,
  suppressReread: true,
  collapseSystem: true,
  stripToolDefs: false,
  pruneUnusedTools: true,
  truncateThreshold: 4096,
  pruneAfterTurns: 6,
  suppressWithinTurns: 2,
  stripToolDefsAfter: 3,
  pruneUnusedToolsAfter: 10,
};

export type OptimizeActionType =
  | "dedup"
  | "truncate"
  | "stable_prefix"
  | "prune_stale"
  | "suppress_reread"
  | "collapse_system"
  | "strip_tool_defs"
  | "prune_unused_tools";

export interface OptimizeAction {
  type: OptimizeActionType;
  turn: number;
  tool?: string;
  tokensSaved: number;
  detail: string;
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

export class OptimizeLayer {
  private readonly config: OptimizeConfig;
  private readonly actions: OptimizeAction[] = [];
  private readonly seenCalls = new Map<string, SeenCall>();
  private readonly recentWrites: WriteRecord[] = [];
  private readonly toolsUsed = new Map<string, number>();
  private turn = 0;
  private lastToolsJson: string | null = null;
  private lastSystemHash: string | null = null;
  private lastSystemTokens = 0;
  private toolsSentCount = 0;

  constructor(config: Partial<OptimizeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getActions(): OptimizeAction[] {
    return [...this.actions];
  }

  getTotalTokensSaved(): number {
    return this.actions.reduce((sum, a) => sum + a.tokensSaved, 0);
  }

  rewriteRequestBody(body: Buffer): Buffer {
    this.turn++;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return body;
    }

    let changed = false;

    // Collapse repeated system prompts to a short hash stub
    if (this.config.collapseSystem && parsed.system != null) {
      const systemStr =
        typeof parsed.system === "string"
          ? parsed.system
          : JSON.stringify(parsed.system);
      const hash = hashContent(systemStr);
      const tokens = estimateTokens(systemStr);
      if (this.lastSystemHash === hash && tokens > 100) {
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

    // Strip tool definitions after N requests (prompt cache makes them redundant)
    if (this.config.stripToolDefs && Array.isArray(parsed.tools)) {
      this.toolsSentCount++;
      if (this.toolsSentCount > this.config.stripToolDefsAfter) {
        const toolsTokens = estimateTokens(JSON.stringify(parsed.tools));
        delete parsed.tools;
        this.actions.push({
          type: "strip_tool_defs",
          turn: this.turn,
          tokensSaved: toolsTokens,
          detail: `stripped tool definitions on turn ${this.turn} (~${toolsTokens} tokens — already cached)`,
        });
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

    return changed ? Buffer.from(JSON.stringify(parsed)) : body;
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
      const lines = content.split("\n");
      if (lines.length > 60) {
        const head = lines.slice(0, 40).join("\n");
        const tail = lines.slice(-15).join("\n");
        const omitted = lines.length - 55;
        const truncated = `${head}\n\n[... ${omitted} lines omitted — ${estimateTokens(lines.slice(40, -15).join("\n"))} tokens saved ...]\n\n${tail}`;
        const saved = tokens - estimateTokens(truncated);
        if (saved > 50) {
          this.actions.push({
            type: "truncate",
            turn: this.turn,
            tool: toolName,
            tokensSaved: saved,
            detail: `${toolName} result truncated: ${lines.length} lines → 55 (saved ~${saved} tokens)`,
          });
          return truncated;
        }
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

  private pruneStaleResults(messages: Message[]): Message[] | null {
    const threshold = this.turn - this.config.pruneAfterTurns;
    if (threshold <= 0) return null;

    let changed = false;
    let msgTurn = 0;
    const result = messages.map((msg) => {
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
          });
          return { ...block, content: summary };
        });
        return { ...msg, content: rewritten };
      }
      return msg;
    });
    return changed ? result : null;
  }

  private resolveToolName(
    messages: Message[],
    toolUseId?: string,
  ): string | null {
    if (!toolUseId) return null;
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return (block.name as string) ?? null;
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
