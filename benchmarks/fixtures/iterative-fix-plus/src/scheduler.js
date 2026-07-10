import { PriorityQueue } from "./priority-queue.js";
import { EventBus } from "./event-bus.js";

/**
 * Task scheduler with priority, dependencies, retry, and timeout support.
 */
export class Scheduler {
  #queue = new PriorityQueue();
  #running = new Map(); // id -> { task, controller, startedAt }
  #completed = new Set();
  #failed = new Map(); // id -> { error, attempts }
  #tasks = new Map(); // id -> task definition
  #bus = new EventBus();
  #maxConcurrency;
  #defaultTimeout;

  constructor(opts = {}) {
    this.#maxConcurrency = opts.maxConcurrency ?? 4;
    this.#defaultTimeout = opts.defaultTimeout ?? 30000;
  }

  get bus() {
    return this.#bus;
  }

  get stats() {
    return {
      queued: this.#queue.size,
      running: this.#running.size,
      completed: this.#completed.size,
      failed: this.#failed.size,
    };
  }

  /**
   * Add a task to the scheduler.
   * task: { id, fn, priority?, deps?, maxRetries?, timeout? }
   */
  add(task) {
    if (!task.id || typeof task.fn !== "function") {
      throw new Error("Task must have an id and fn");
    }
    if (this.#tasks.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    const def = {
      id: task.id,
      fn: task.fn,
      priority: task.priority ?? 5,
      deps: task.deps ?? [],
      maxRetries: task.maxRetries ?? 0,
      timeout: task.timeout ?? this.#defaultTimeout,
      attempts: 0,
    };
    this.#tasks.set(task.id, def);
    this.#queue.push(def, def.priority);
    this.#bus.emit("task:added", { id: def.id, priority: def.priority });
    return this;
  }

  /** Start processing. Returns when all tasks are done or failed. */
  async run() {
    this.#bus.emit("scheduler:start", this.stats);
    while (this.#queue.size > 0 || this.#running.size > 0) {
      this.#scheduleReady();
      if (this.#running.size > 0) {
        await Promise.race([...this.#running.values()].map((r) => r.promise));
      }
    }
    this.#bus.emit("scheduler:done", this.stats);
    return {
      completed: [...this.#completed],
      failed: [...this.#failed.keys()],
    };
  }

  /** Cancel a running or queued task. */
  cancel(id) {
    const running = this.#running.get(id);
    if (running) {
      running.controller.abort();
      this.#running.delete(id);
      this.#bus.emit("task:cancelled", { id });
      return true;
    }
    const task = this.#tasks.get(id);
    if (task) {
      this.#queue.remove(task);
      this.#tasks.delete(id);
      this.#bus.emit("task:cancelled", { id });
      return true;
    }
    return false;
  }

  #scheduleReady() {
    while (this.#running.size < this.#maxConcurrency && this.#queue.size > 0) {
      const task = this.#queue.peek();
      if (!task) break;
      if (
        task.deps.length > 0 &&
        task.deps.some((d) => this.#completed.has(d))
      ) {
        break; // blocked
      }
      this.#queue.pop();
      this.#execute(task);
    }
  }

  async #execute(task) {
    task.attempts++;
    const controller = new AbortController();
    const startedAt = Date.now();

    const timeoutId = setTimeout(() => {
      controller.abort(
        new Error(`Task ${task.id} timed out after ${task.timeout}ms`),
      );
    }, task.timeout);

    const promise = this.#runTask(task, controller.signal)
      .then(() => {
        clearTimeout(timeoutId);
        this.#running.delete(task.id);
        this.#completed.add(task.id);
        this.#bus.emit("task:completed", {
          id: task.id,
          duration: Date.now() - startedAt,
          attempts: task.attempts,
        });
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        this.#running.delete(task.id);
        if (task.attempts < task.maxRetries) {
          this.#queue.push(task, task.attempts);
          this.#bus.emit("task:retry", {
            id: task.id,
            attempt: task.attempts,
            error: err.message,
          });
        } else {
          this.#failed.set(task.id, {
            error: err.message,
            attempts: task.attempts,
          });
          this.#bus.emit("task:failed", {
            id: task.id,
            error: err.message,
            attempts: task.attempts,
          });
        }
      });

    this.#running.set(task.id, { task, controller, promise, startedAt });
    this.#bus.emit("task:started", { id: task.id, attempt: task.attempts });
  }

  async #runTask(task, signal) {
    if (signal.aborted) throw signal.reason;
    return task.fn(signal);
  }
}
