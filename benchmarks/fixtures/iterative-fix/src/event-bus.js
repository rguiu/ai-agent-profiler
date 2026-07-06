/**
 * Simple typed event emitter for scheduler lifecycle events.
 */
export class EventBus {
  #listeners = new Map(); // event -> Set<fn>
  #history = [];
  #maxHistory;

  constructor(opts = {}) {
    this.#maxHistory = opts.maxHistory ?? 100;
  }

  /** Subscribe to an event. Returns unsubscribe function. */
  on(event, fn) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  /** Subscribe to the next occurrence only. */
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const set = this.#listeners.get(event);
    if (set) set.delete(fn);
  }

  emit(event, data) {
    this.#history.push({ event, data, ts: Date.now() });
    // BUG #4: history trimming is backwards (keeps oldest, drops newest)
    if (this.#history.length > this.#maxHistory) {
      this.#history.splice(0, 0, ...this.#history.splice(this.#maxHistory));
      this.#history.length = this.#maxHistory;
    }
    const set = this.#listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          fn(data);
        } catch {
          // listeners should not throw
        }
      }
    }
  }

  /** Get the last N events (most recent first). */
  history(n = 10) {
    return this.#history.slice(-n).reverse();
  }

  /** Wait for a specific event with optional timeout. */
  waitFor(event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(
          new Error(`Timed out waiting for "${event}" after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const handler = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
      this.once(event, handler);
    });
  }

  /** Count listeners for an event. */
  listenerCount(event) {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /** Remove all listeners. */
  clear() {
    this.#listeners.clear();
    this.#history = [];
  }
}
