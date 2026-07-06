// The OptimizeLayer tracks per-session state and applies optimizations to
// request/response bodies passing through the proxy. It only activates when
// aap serve --optimize is used.

export interface OptimizeConfig {
  dedup: boolean;
  truncate: boolean;
  stablePrefix: boolean;
  pruneStale: boolean;
  truncateThreshold: number; // bytes; results larger than this get truncated
  pruneAfterTurns: number; // prune tool results older than this many turns
}

export const DEFAULT_CONFIG: OptimizeConfig = {
  dedup: true,
  truncate: true,
  stablePrefix: true,
  pruneStale: false, // off by default — medium risk
  truncateThreshold: 8192,
  pruneAfterTurns: 10,
};

export interface OptimizeAction {
  type: "dedup" | "truncate" | "stable_prefix" | "prune_stale";
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
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`);
  return `{${sorted.join(",")}}`;
}

export class OptimizeLayer {
  private readonly config: OptimizeConfig;
  private readonly actions: OptimizeAction[] = [];
  private readonly seenCalls = new Map<string, SeenCall>();
  private turn = 0;
  private lastToolsJson: string | null = null;

  constructor(config: Partial<OptimizeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getActions(): OptimizeAction[] {
    return [...this.actions];
  }

  getTotalTokensSaved(): number {
    return this.actions.reduce((sum, a) => sum + a.tokensSaved, 0);
  }

  // Called for each request body going upstream. Returns the (possibly rewritten) body.
  rewriteRequestBody(body: Buffer): Buffer {
    this.turn++;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    } catch {
      return body;
    }

    let changed = false;

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

  // Called for each tool result in a response. Returns the (possibly rewritten) content.
  rewriteToolResult(toolName: string, args: string, content: string): string {
    const key = `${toolName}:${args}`;
    const contentHash = hashContent(content);
    const tokens = estimateTokens(content);

    // Dedup: if we've seen this exact call+result before, return a stub
    if (this.config.dedup) {
      const prev = this.seenCalls.get(key);
      if (prev && prev.resultHash === contentHash) {
        const saved = tokens - estimateTokens(`[unchanged since turn ${prev.turn}]`);
        if (saved > 0) {
          this.actions.push({
            type: "dedup",
            turn: this.turn,
            tool: toolName,
            tokensSaved: saved,
            detail: `${toolName}(${args.slice(0, 60)}) unchanged since turn ${prev.turn}`,
          });
          return `[unchanged since turn ${prev.turn} — ${tokens} tokens omitted]`;
        }
      }
      this.seenCalls.set(key, { turn: this.turn, resultHash: contentHash, resultTokens: tokens });
    }

    // Truncate: if content exceeds threshold, show head+tail
    if (this.config.truncate && content.length > this.config.truncateThreshold) {
      const lines = content.split("\n");
      if (lines.length > 80) {
        const head = lines.slice(0, 50).join("\n");
        const tail = lines.slice(-20).join("\n");
        const omitted = lines.length - 70;
        const truncated = `${head}\n\n[... ${omitted} lines omitted — use expand() for full content ...]\n\n${tail}`;
        const saved = tokens - estimateTokens(truncated);
        if (saved > 0) {
          this.actions.push({
            type: "truncate",
            turn: this.turn,
            tool: toolName,
            tokensSaved: saved,
            detail: `${toolName} result truncated: ${lines.length} lines → 70 (saved ~${saved} tokens)`,
          });
          return truncated;
        }
      }
    }

    return content;
  }

  private stabiliseTools(tools: unknown[]): unknown[] {
    const json = canonicalJson(tools);
    const canonical = JSON.parse(json) as unknown[];
    if (this.lastToolsJson !== null && json !== this.lastToolsJson) {
      this.actions.push({
        type: "stable_prefix",
        turn: this.turn,
        tokensSaved: 0, // savings come from improved cache hit rate, not fewer tokens
        detail: "tool definitions canonicalised for byte-stable prefix (improves prompt cache hit)",
      });
    }
    this.lastToolsJson = json;
    return canonical;
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

      // Check if this is a tool_result content block
      if (Array.isArray(msg.content)) {
        const rewritten = msg.content.map((block: ContentBlock) => {
          if (block.type !== "tool_result") return block;
          if (!block.content || typeof block.content !== "string") return block;
          const tokens = estimateTokens(block.content);
          if (tokens < 100) return block; // don't prune small results
          changed = true;
          this.actions.push({
            type: "prune_stale",
            turn: this.turn,
            tokensSaved: tokens - 10,
            detail: `pruned tool_result from turn ${msgTurn} (~${tokens} tokens)`,
          });
          return { ...block, content: `[pruned — stale result from turn ${msgTurn}]` };
        });
        return { ...msg, content: rewritten };
      }
      return msg;
    });
    return changed ? result : null;
  }
}

interface ContentBlock {
  type: string;
  content?: string;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content?: string | ContentBlock[];
  [key: string]: unknown;
}
