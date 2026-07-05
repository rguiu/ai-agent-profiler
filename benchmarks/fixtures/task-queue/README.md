# task-queue

A small in-memory priority task queue, used as a benchmark fixture.

- `src/task.js` — the task model (`createTask`)
- `src/store.js` — in-memory task storage (`Store`)
- `src/scheduler.js` — picks the next task to run (`selectNext`)
- `src/queue.js` — the public `Queue` (enqueue / next / complete / size)
- `src/index.js` — entry point
- `test/` — tests (`node --test`)

Tasks should run highest-priority first. Run the tests with `npm test`.
