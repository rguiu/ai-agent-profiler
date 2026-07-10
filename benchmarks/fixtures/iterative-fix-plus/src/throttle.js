/**
 * Sliding-window request throttle. Tracks per-user timestamps and rejects
 * requests that would exceed maxRequests within the configured windowMs.
 */
export class SlidingWindowThrottle {
  #maxRequests;
  #windowMs;
  #requests = new Map(); // userId -> number[]

  constructor(maxRequests, windowMs) {
    this.#maxRequests = maxRequests;
    this.#windowMs = windowMs;
  }

  get maxRequests() { return this.#maxRequests; }
  get windowMs() { return this.#windowMs; }

  /**
   * Check whether userId is allowed to make a request at the given timestamp.
   * Returns true and records the request if allowed, false otherwise.
   * @param {string} userId
   * @param {number} [timestamp=Date.now()]
   * @returns {boolean}
   */
  isAllowed(userId, timestamp = Date.now()) {
    if (!this.#requests.has(userId)) {
      this.#requests.set(userId, []);
    }
    const userLog = this.#requests.get(userId);
    const windowStart = timestamp - this.#windowMs;

    const activeRequests = userLog.filter(ts => ts > windowStart);
    this.#requests.set(userId, activeRequests);

    if (activeRequests.length < this.#maxRequests) {
      activeRequests.push(timestamp);
      return true;
    }
    return false;
  }

  /** Remove all history for a user. */
  reset(userId) {
    this.#requests.delete(userId);
  }

  /** Number of active (non-expired) requests for a user at the given time. */
  activeCount(userId, timestamp = Date.now()) {
    const userLog = this.#requests.get(userId);
    if (!userLog) return 0;
    const windowStart = timestamp - this.#windowMs;
    return userLog.filter(ts => ts > windowStart).length;
  }
}
