import test from "node:test";
import assert from "node:assert/strict";
import { parse, parseLine } from "./parser.js";

test("parseLine splits and trims cells", () => {
  assert.deepEqual(parseLine("a, b ,c"), ["a", "b", "c"]);
});

test("parse returns one object per data row, skipping the header", () => {
  const rows = parse("name,age\nAlice,30\nBob,25\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "Alice", age: "30" });
  assert.deepEqual(rows[1], { name: "Bob", age: "25" });
});

test("parse handles an empty input", () => {
  assert.deepEqual(parse(""), []);
});
