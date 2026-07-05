import test from "node:test";
import assert from "node:assert/strict";
import { Queue } from "../src/queue.js";
import { createTask } from "../src/task.js";

test("enqueue increases pending size", () => {
  const q = new Queue();
  q.enqueue(createTask("a", { priority: 1 }));
  q.enqueue(createTask("b", { priority: 2 }));
  assert.equal(q.size(), 2);
});

test("complete removes a task from pending", () => {
  const q = new Queue();
  q.enqueue(createTask("a", { priority: 1 }));
  q.complete("a");
  assert.equal(q.size(), 0);
});
