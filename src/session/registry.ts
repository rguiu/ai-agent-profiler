export interface SessionInfo {
  id: string;
  client?: string;
  cwd?: string;
  repo?: string | null;
  startedAt: string;
  meta?: Record<string, string> | null;
}

/** Sessions untouched for longer than this are treated as inactive and swept
 * out of the in-memory map. They recover automatically if seen again. */
export const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000; // 2h

interface Entry {
  info: SessionInfo;
  lastSeen: number;
}

/** Loads a persisted session by id — lets the registry recover a session that
 * was pruned from memory (or never hydrated) without needing a re-register. */
export type SessionLoader = (id: string) => SessionInfo | undefined;

export class SessionRegistry {
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly idleMs: number = DEFAULT_IDLE_MS,
    private readonly loader?: SessionLoader,
  ) {}

  register(info: SessionInfo, now: number = Date.now()): void {
    this.sessions.set(info.id, { info, lastSeen: now });
  }

  /** Look up a session, refreshing its activity so it isn't swept as idle. On
   * an in-memory miss, falls back to the persisted store (if a loader was
   * given) and repopulates the entry — this is the "recover if seen again"
   * path after a prune or a restart with no hydration. */
  get(id: string, now: number = Date.now()): SessionInfo | undefined {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.lastSeen = now;
      return entry.info;
    }
    const loaded = this.loader?.(id);
    if (loaded) {
      this.sessions.set(id, { info: loaded, lastSeen: now });
      return loaded;
    }
    return undefined;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((e) => e.info);
  }

  hydrate(rows: SessionInfo[], now: number = Date.now()): void {
    for (const row of rows) {
      if (!this.sessions.has(row.id)) {
        this.sessions.set(row.id, { info: row, lastSeen: now });
      }
    }
  }

  /** Evict sessions idle longer than `idleMs`. Returns the count removed.
   * Evicted sessions are only dropped from memory — their persisted state is
   * untouched, so a later request re-registers (recovers) them. */
  prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeen > this.idleMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
