/**
 * Minimal insertion-ordered LRU map. Bounds memory for per-session state that
 * would otherwise grow unbounded (e.g. the last request body kept per session
 * for cache diagnostics). Relies on JS `Map` preserving insertion order: the
 * first key is the least-recently-used and is evicted once `max` is exceeded.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {
    if (max <= 0) throw new Error("LruMap: max must be positive");
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Refresh recency: re-insert so the key moves to the most-recent end.
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: K, val: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
