export class Store {
  constructor() {
    this.tasks = new Map();
  }

  add(task) {
    this.tasks.set(task.id, task);
  }

  get(id) {
    return this.tasks.get(id);
  }

  pending() {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }

  remove(id) {
    this.tasks.delete(id);
  }
}
