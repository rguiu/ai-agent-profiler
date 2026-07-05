# bench-fixture

A tiny CSV parser. `parse(input)` takes CSV text with a header row and returns
an array of row objects keyed by the header columns.

- `src/parser.js` — the parser (`parse`, `parseLine`)
- `src/index.js` — public entry point
- `src/parser.test.js` — tests (`node --test`)

Run the tests with `npm test`.
