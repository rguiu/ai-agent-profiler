import test from "node:test";
import assert from "node:assert/strict";
import { define, byCategory } from "../src/glossary.js";

test("define is case-insensitive", () => {
  const entry = define("TOPIC5");
  assert.ok(entry, "expected define('TOPIC5') to find topic5");
  assert.equal(entry.term, "topic5");
});

test("byCategory returns entries in that category", () => {
  assert.ok(byCategory("network").length > 0);
});
