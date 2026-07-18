import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  claudeProjectsDir,
  parseTranscript,
} from "../../analyze/claude-transcript.js";
import { buildDrafts, itemsFromMessage } from "../extract.js";
import type { ChunkSource } from "../extract.js";
import type { SearchStore } from "../search-store.js";

export interface ClaudeImportSummary {
  transcripts: number;
  messages: number;
  chunks: number;
}

// All .jsonl transcripts under ~/.claude/projects/<slug>/.
export function discoverClaudeTranscripts(home?: string): string[] {
  const root = claudeProjectsDir(home);
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(root, dir, entry));
    }
  }
  return files;
}

// Import one Claude Code transcript. Each message becomes a synthetic
// "request" keyed cc:<message-uuid>, so incremental imports only process
// messages not yet in index_state. Sessions that were ALSO proxied share the
// same session id, so identical content dedupes via (session_id, hash).
export function importClaudeTranscript(
  path: string,
  search: SearchStore,
  indexed: ReadonlySet<string>,
): ClaudeImportSummary {
  const transcript = parseTranscript(path);
  const sessionId = transcript.sessionId ?? basename(path, ".jsonl");
  const toolNameById = new Map<string, string>();
  let messages = 0;
  let chunks = 0;

  for (const message of transcript.messages) {
    const requestId = `cc:${message.uuid}`;
    // Tool names must accumulate over the whole conversation even when the
    // message itself is skipped, so results keep their attribution.
    const msg = { role: message.role, content: message.content };
    const items = itemsFromMessage(message.role, msg, toolNameById);
    if (indexed.has(requestId)) continue;

    const source: ChunkSource = {
      requestId,
      sessionId,
      ts: message.timestamp ?? null,
      model: message.model ?? null,
      provider: null,
      requestKind: message.isCompactSummary ? "compact" : null,
      repo: null,
      cwd: transcript.cwd,
      client: "claude-import",
    };
    chunks += search.indexRequest(
      requestId,
      source,
      buildDrafts(items, requestId),
    );
    messages++;
  }
  return { transcripts: 1, messages, chunks };
}
