export function createTask(id, { priority = 0, run } = {}) {
  return { id, priority, run, status: "pending" };
}
