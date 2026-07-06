/**
 * Token-bucket rate limiter for controlling task execution frequency.
 */
export class RateLimiter {
  #tokens;
  #maxTokens;
  #refillRate; // tokens per ms
  #lastRefill;
  #waiters = [];

  /**
   * @param {number} maxPerSecond - Maximum operations per second
   * @param {number} burst - Burst capacity (default: same as maxPerSecond)
   */
  constructor(maxPerSecond, burst) {
    this.#maxTokens = burst ?? maxPerSecond;
    this.#tokens = this.#maxTokens;
    this.#refillRate = maxPerSecond / 1000;
    this.#lastRefill = Date.now();
  }

  get available() {
    this.#refill();
    return Math.floor(this.#tokens);
  }

  /** Acquire one token. Resolves when a token is available. */
  async acquire() {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return;
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
      const waitMs = (1 - this.#tokens) / this.#refillRate;
      setTimeout(() => this.#processWaiters(), waitMs);
    });
  }

  /** Try to acquire without waiting. Returns false if unavailable. */
  tryAcquire() {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }

  /** Acquire multiple tokens at once. */
  async acquireMany(n) {
    if (n <= 0) throw new Error("Must acquire at least 1 token");
    if (n > this.#maxTokens) {
      throw new Error(`Cannot acquire ${n} tokens (max burst: ${this.#maxTokens})`);
    }
    for (let i = 0; i < n; i++) {
      await this.acquire();
    }
  }

  /** Execute fn with rate limiting. */
  async execute(fn) {
    await this.acquire();
    return fn();
  }

  /** Reset to full capacity. */
  reset() {
    this.#tokens = this.#maxTokens;
    this.#lastRefill = Date.now();
    this.#processWaiters();
  }

  #refill() {
    const now = Date.now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(this.#maxTokens, this.#tokens + elapsed * this.#refillRate);
    this.#lastRefill = now;
  }

  #processWaiters() {
    this.#refill();
    while (this.#waiters.length > 0 && this.#tokens >= 1) {
      this.#tokens -= 1;
      const resolve = this.#waiters.shift();
      resolve();
    }
  }
}
