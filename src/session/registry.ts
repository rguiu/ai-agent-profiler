export interface SessionInfo {
  id: string;
  client?: string;
  cwd?: string;
  repo?: string | null;
  startedAt: string;
  meta?: Record<string, string> | null;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();

  register(info: SessionInfo): void {
    this.sessions.set(info.id, info);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  hydrate(rows: SessionInfo[]): void {
    for (const row of rows) {
      if (!this.sessions.has(row.id)) {
        this.sessions.set(row.id, row);
      }
    }
  }
}
