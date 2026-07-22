import { Scheduler } from "./scheduler.js";
import { RateLimiter } from "./rate-limiter.js";
import { ResultCache } from "./result-cache.js";

/**
 * Pipeline orchestrator: runs a sequence of named stages, each with
 * multiple tasks. Tasks within a stage can run in parallel (up to concurrency
 * limit). Stages run sequentially. Results from earlier stages are available
 * to later ones via the shared context.
 */
export class Pipeline {
  #stages = [];
  #context = {};
  #limiter;
  #cache;
  #aborted = false;

  constructor(opts = {}) {
    this.#limiter = opts.limiter ?? new RateLimiter(10);
    this.#cache = opts.cache ?? new ResultCache(50, opts.cacheTtl ?? 30000);
  }

  /** Add a stage with tasks. Each task: { id, fn(ctx) } */
  addStage(name, tasks) {
    if (!name || !Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("Stage needs a name and at least one task");
    }
    this.#stages.push({ name, tasks });
    return this;
  }

  /** Run the full pipeline. Returns the final context. */
  async run(initialContext = {}) {
    this.#context = { ...initialContext };
    this.#aborted = false;

    for (const stage of this.#stages) {
      if (this.#aborted) break;
      await this.#runStage(stage);
    }
    return this.#context;
  }

  abort() {
    this.#aborted = true;
  }

  getContext() {
    return { ...this.#context };
  }

  async #runStage(stage) {
    const scheduler = new Scheduler({ maxConcurrency: 4 });

    for (const task of stage.tasks) {
      scheduler.add({
        id: `${stage.name}:${task.id}`,
        priority: task.priority ?? 5,
        fn: async (signal) => {
          if (signal.aborted) throw new Error("Aborted");
          await this.#limiter.acquire();
          const cacheKey = `${stage.name}:${task.id}`;
          const cached = this.#cache.get(cacheKey);
          if (cached !== undefined) {
            this.#context[task.id] = cached;
            return;
          }
          const result = await task.fn({ ...this.#context, signal });
          this.#cache.set(cacheKey, result);
          this.#context[task.id] = result;
          if (
            result !== null &&
            typeof result === "object" &&
            !Array.isArray(result)
          ) {
            Object.assign(this.#context, result);
          }
        },
      });
    }

    await scheduler.run();
  }
}
