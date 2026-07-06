/**
 * Min-heap priority queue. Lower priority numbers run first.
 */
export class PriorityQueue {
  #heap = [];

  get size() {
    return this.#heap.length;
  }

  isEmpty() {
    return this.#heap.length === 0;
  }

  /** Push an item with the given numeric priority. */
  push(item, priority) {
    this.#heap.push({ item, priority });
    this.#bubbleUp(this.#heap.length - 1);
  }

  /** Remove and return the highest-priority (lowest number) item. */
  pop() {
    if (this.isEmpty()) return undefined;
    const top = this.#heap[0];
    const last = this.#heap.pop();
    if (this.#heap.length > 0 && last) {
      this.#heap[0] = last;
      this.#sinkDown(0);
    }
    return top.item;
  }

  /** Peek at the top without removing. */
  peek() {
    return this.isEmpty() ? undefined : this.#heap[0].item;
  }

  /** Remove a specific item (first occurrence). Returns true if found. */
  remove(item) {
    const idx = this.#heap.findIndex((e) => e.item === item);
    if (idx === -1) return false;
    const last = this.#heap.pop();
    if (idx < this.#heap.length && last) {
      this.#heap[idx] = last;
      this.#sinkDown(idx);
      this.#bubbleUp(idx);
    }
    return true;
  }

  /** Change the priority of an existing item. */
  updatePriority(item, newPriority) {
    const idx = this.#heap.findIndex((e) => e.item === item);
    if (idx === -1) return false;
    this.#heap[idx].priority = newPriority;
    this.#sinkDown(idx);
    this.#bubbleUp(idx);
    return true;
  }

  toArray() {
    return this.#heap
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((e) => e.item);
  }

  // BUG #1: parent calculation is wrong (should be Math.floor((i - 1) / 2))
  #bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor(i / 2);
      if (this.#heap[parent].priority <= this.#heap[i].priority) break;
      [this.#heap[parent], this.#heap[i]] = [this.#heap[i], this.#heap[parent]];
      i = parent;
    }
  }

  #sinkDown(i) {
    const n = this.#heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.#heap[left].priority < this.#heap[smallest].priority) {
        smallest = left;
      }
      if (right < n && this.#heap[right].priority < this.#heap[smallest].priority) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.#heap[smallest], this.#heap[i]] = [this.#heap[i], this.#heap[smallest]];
      i = smallest;
    }
  }
}
