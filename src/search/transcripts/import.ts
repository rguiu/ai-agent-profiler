import type { Store } from "../../store/index.js";
import type { SearchStore } from "../search-store.js";
import { discoverClaudeTranscripts, importClaudeTranscript } from "./claude.js";
import { importOpencode, type ProxiedSessionWindow } from "./opencode.js";

export interface TranscriptImportSummary {
  claudeTranscripts: number;
  claudeMessages: number;
  opencodeSessions: number;
  opencodeSkippedProxied: number;
  opencodeMessages: number;
  chunks: number;
}

export interface TranscriptImportOptions {
  claude?: boolean;
  opencode?: boolean;
  // Import opencode sessions even when a proxied session overlaps.
  includeProxied?: boolean;
  home?: string;
  opencodeDbPath?: string;
}

// Fill the memory gaps: index conversations recorded by the agents
// themselves (Claude Code .jsonl transcripts, opencode's local DB) that never
// went through the proxy. Off-hot-path, idempotent, additive to the same
// search.sqlite — raw agent files are never modified.
export function runTranscriptImport(
  store: Store | null,
  search: SearchStore,
  opts: TranscriptImportOptions = {},
): TranscriptImportSummary {
  const summary: TranscriptImportSummary = {
    claudeTranscripts: 0,
    claudeMessages: 0,
    opencodeSessions: 0,
    opencodeSkippedProxied: 0,
    opencodeMessages: 0,
    chunks: 0,
  };
  const indexed = search.indexedRequestIds();

  if (opts.claude !== false) {
    for (const path of discoverClaudeTranscripts(opts.home)) {
      try {
        const result = importClaudeTranscript(path, search, indexed);
        summary.claudeTranscripts += result.transcripts;
        summary.claudeMessages += result.messages;
        summary.chunks += result.chunks;
      } catch (err) {
        console.error(`import: ${path} failed: ${(err as Error).message}`);
      }
    }
  }

  if (opts.opencode !== false) {
    const proxiedSessions: ProxiedSessionWindow[] =
      store?.listSessions().map((s) => ({
        cwd: s.cwd,
        startedAt: s.started_at ?? s.first_seen_at,
        lastSeenAt: s.last_seen_at,
      })) ?? [];
    const result = importOpencode(search, indexed, {
      dbPath: opts.opencodeDbPath,
      proxiedSessions,
      includeProxied: opts.includeProxied,
    });
    summary.opencodeSessions = result.sessions;
    summary.opencodeSkippedProxied = result.skippedProxied;
    summary.opencodeMessages = result.messages;
    summary.chunks += result.chunks;
  }

  return summary;
}
