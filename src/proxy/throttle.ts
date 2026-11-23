export interface ThrottleConfig {
  maxConcurrent: number;
  maxQueued: number;
  timeoutMs: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  maxConcurrent: 8,
  maxQueued: 64,
  timeoutMs: 180_000,
};

/** Live view of the throttle, for /health and the in-flight diagnostics. */
export interface ThrottleStats {
  inflight: number;
  queued: number;
  oldestQueuedMs: number;
  maxConcurrent: number;
  maxQueued: number;
}

export class ThrottleQueueFullError extends Error {
  override name = "ThrottleQueueFullError";
}

export class ThrottleAbortedError extends Error {
  override name = "ThrottleAbortedError";
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  queuedAt: number;
  cleanup: () => void;
}

export class Throttle {
  private readonly config: ThrottleConfig;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(config: Partial<ThrottleConfig> = {}) {
    this.config = { ...DEFAULT_THROTTLE, ...config };
  }

  get pending(): number {
    return this.queue.length;
  }

  get inflight(): number {
    return this.active;
  }

  stats(now: number = Date.now()): ThrottleStats {
    const oldest = this.queue[0];
    return {
      inflight: this.active,
      queued: this.queue.length,
      oldestQueuedMs: oldest ? Math.max(0, now - oldest.queuedAt) : 0,
      maxConcurrent: this.config.maxConcurrent,
      maxQueued: this.config.maxQueued,
    };
  }

  /**
   * Take a slot, waiting in the queue when all are busy. `signal` lets a request
   * the client abandoned while queued drop out immediately instead of holding a
   * place (and an unfinished trace) until the queue timeout.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new ThrottleAbortedError("throttle: aborted"));
    }
    if (this.active < this.config.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.config.maxQueued) {
      return Promise.reject(
        new ThrottleQueueFullError("throttle: queue full — backpressure"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        queuedAt: Date.now(),
        cleanup: (): void => {},
      } as Waiter;

      const drop = (err: Error): void => {
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) this.queue.splice(idx, 1);
        waiter.cleanup();
        reject(err);
      };

      waiter.cleanup = (): void => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
      };
      waiter.timer = setTimeout(
        () => drop(new Error("throttle: timed out waiting for slot")),
        this.config.timeoutMs,
      );
      const onAbort = (): void => {
        drop(new ThrottleAbortedError("throttle: aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  release(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.cleanup();
      waiter.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}
