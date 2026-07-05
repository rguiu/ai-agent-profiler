import { Store } from "./store.js";
import { selectNext } from "./scheduler.js";

export class Queue {
  constructor() {
    this.store = new Store();
  }

  enqueue(task) {
    this.store.add(task);
    return task.id;
  }

  next() {
    return selectNext(this.store.pending());
  }

  complete(id) {
    const task = this.store.get(id);
    if (task) task.status = "done";
  }

  size() {
    return this.store.pending().length;
  }
}
