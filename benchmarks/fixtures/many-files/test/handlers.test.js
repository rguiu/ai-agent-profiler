import test from "node:test";
import assert from "node:assert/strict";
import { handlers, run } from "../src/registry.js";

test("every handler doubles its input", () => {
  for (const id of Object.keys(handlers)) {
    assert.equal(run(id, 5), 10, `handler ${id} should return 10 for input 5`);
  }
});
