// Selects the next task to run: highest priority first.
export function selectNext(tasks) {
  if (tasks.length === 0) return undefined;
  let best = tasks[0];
  for (const task of tasks) {
    // BUG: this comparison keeps the LOWEST priority task instead of the highest.
    if (task.priority < best.priority) best = task;
  }
  return best;
}
