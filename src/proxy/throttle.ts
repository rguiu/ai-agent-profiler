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

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

  async acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrent) {
      this.active++;
      return;
    }
    if (this.queue.length >= this.config.maxQueued) {
      throw new Error("throttle: queue full — backpressure");
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error("throttle: timed out waiting for slot"));
      }, this.config.timeoutMs);
      this.queue.push({ resolve, reject, timer });
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}
