/**
 * Live view of every request the proxy is currently holding, plus the phase it
 * is stuck in. `aap` used to be opaque while wedged: requests were captured (so
 * they looked "logged") but never forwarded, and the only remedy was a restart.
 * This makes the hold-up visible over HTTP while it is happening — which phase,
 * for how long, and behind how many busy slots.
 */
export type RequestPhase = "queued" | "connecting" | "upstream" | "finishing";

export interface InflightMeta {
  id: string;
  sessionId: string | null;
  provider: string;
  method: string;
  path: string;
  upstream: string;
  client: string | null;
}

export interface InflightSnapshot extends InflightMeta {
  phase: RequestPhase;
  ageMs: number;
  queuedMs: number;
  streamingMs: number;
}

export interface InflightHandle {
  /** Advance the phase marker. Cheap: it only mutates the live map. */
  phase(next: RequestPhase): void;
  /** Stamp how long the request waited for a slot, once it has one. */
  started(): void;
  end(): void;
}

/** Hard cap so a pathological leak cannot exhaust memory; oldest entries are
 * dropped from the *diagnostic* view only (the request keeps running). */
const MAX_TRACKED = 512;

export class InflightTracker {
  private readonly live = new Map<
    string,
    {
      meta: InflightMeta;
      phase: RequestPhase;
      startedAt: number;
      queuedMs: number;
    }
  >();

  begin(meta: InflightMeta, now: number = Date.now()): InflightHandle {
    if (this.live.size >= MAX_TRACKED) {
      const oldest = this.live.keys().next().value;
      if (oldest !== undefined) this.live.delete(oldest);
    }
    const entry = {
      meta,
      phase: "queued" as RequestPhase,
      startedAt: now,
      queuedMs: 0,
    };
    this.live.set(meta.id, entry);
    return {
      phase: (next: RequestPhase): void => {
        entry.phase = next;
      },
      started: (): void => {
        entry.queuedMs = Math.max(0, Date.now() - entry.startedAt);
      },
      end: (): void => {
        this.live.delete(meta.id);
      },
    };
  }

  snapshot(now: number = Date.now()): InflightSnapshot[] {
    return [...this.live.values()]
      .map((entry) => ({
        ...entry.meta,
        phase: entry.phase,
        ageMs: Math.max(0, now - entry.startedAt),
        queuedMs: entry.queuedMs,
        streamingMs:
          entry.phase === "queued"
            ? 0
            : Math.max(0, now - entry.startedAt - entry.queuedMs),
      }))
      .sort((a, b) => b.ageMs - a.ageMs);
  }

  get size(): number {
    return this.live.size;
  }
}
