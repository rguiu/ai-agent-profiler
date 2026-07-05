import test from "node:test";
import assert from "node:assert/strict";
import { selectNext } from "../src/scheduler.js";
import { createTask } from "../src/task.js";

test("selectNext returns the highest-priority task", () => {
  const tasks = [
    createTask("a", { priority: 1 }),
    createTask("b", { priority: 5 }),
    createTask("c", { priority: 3 }),
  ];
  assert.equal(selectNext(tasks).id, "b");
});

test("selectNext returns undefined for an empty list", () => {
  assert.equal(selectNext([]), undefined);
});
