/**
 * LRU cache for task results with TTL expiration.
 */
export class ResultCache {
  #entries = new Map(); // key -> { value, expiresAt, accessCount }
  #maxSize;
  #defaultTtl;

  /**
   * @param {number} maxSize - Maximum cached entries
   * @param {number} defaultTtlMs - Time-to-live in milliseconds (default 60s)
   */
  constructor(maxSize = 100, defaultTtlMs = 60000) {
    this.#maxSize = maxSize;
    this.#defaultTtl = defaultTtlMs;
  }

  get size() {
    return this.#entries.size;
  }

  /** Store a value. Returns the cache instance for chaining. */
  set(key, value, ttlMs) {
    const ttl = ttlMs ?? this.#defaultTtl;
    if (this.#entries.size >= this.#maxSize && !this.#entries.has(key)) {
      this.#evictLRU();
    }
    this.#entries.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      accessCount: 0,
      lastAccess: Date.now(),
    });
    return this;
  }

  /** Get a value if it exists and hasn't expired. */
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    entry.accessCount++;
    entry.lastAccess = Date.now();
    return entry;
  }

  /** Check if a key exists and is not expired. */
  has(key) {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  /** Remove an entry. Returns true if it existed. */
  delete(key) {
    return this.#entries.delete(key);
  }

  /** Get or compute: returns cached value, or computes and caches it. */
  async getOrCompute(key, computeFn, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await computeFn();
    this.set(key, value, ttlMs);
    return value;
  }

  /** Remove all expired entries. */
  prune() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now > entry.expiresAt) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Get cache stats. */
  stats() {
    let expired = 0;
    const now = Date.now();
    for (const entry of this.#entries.values()) {
      if (now > entry.expiresAt) expired++;
    }
    return {
      size: this.#entries.size,
      maxSize: this.#maxSize,
      expired,
      active: this.#entries.size - expired,
    };
  }

  clear() {
    this.#entries.clear();
  }

  /**
   * Return the keys of the `n` most-accessed entries, most-accessed first.
   * Access count is the number of successful get() calls for a key. Ties may be
   * broken in any order. Returns at most `n` keys (fewer if the cache is smaller).
   * Expired entries are not counted.
   *
   * @param {number} n
   * @returns {string[]}
   */
  topKeys(n) {
    throw new Error("not implemented: ResultCache.topKeys");
  }

  #evictLRU() {
    let target = null;
    let targetAccess = -Infinity;
    for (const [key, entry] of this.#entries) {
      if (entry.lastAccess > targetAccess) {
        target = key;
        targetAccess = entry.lastAccess;
      }
    }
    if (target) this.#entries.delete(target);
  }
}
