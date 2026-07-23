import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/registry.js";

test("every handler doubles its input", () => {
  for (let i = 0; i <= 39; i++) {
    const id = i < 10 ? String(i).padStart(2, "0") : i;
    assert.equal(run(id, 5), 10, `handler ${id} should return 10 for input 5`);
  }
});
