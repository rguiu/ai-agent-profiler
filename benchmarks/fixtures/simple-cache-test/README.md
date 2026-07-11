# Simple Cache Test Fixture

This fixture provides a minimal example to test caching optimizations without breaking correctness.

## What it includes

- `src/memo.js`: A simple memoization utility and a naive Fibonacci implementation.
- `src/index.js`: Re-exports the memoized Fibonacci function and the memoize helper.
- `test/memo.test.js`: Tests that verify:
  - The memoized function returns correct results.
  - The underlying expensive function is called only once per unique argument.
  - Call count matches the number of distinct inputs (proving caching works).

## How to use

Run the test suite:

```bash
npm test
```

The test passes if caching is working; any optimization that inadvertently breaks the cache (e.g., by altering argument ordering or removing the memoization wrapper) will cause the test to fail.

## Intended purpose

Use this fixture when experimenting with optimizations that manipulate prompts, tool calls, or context to ensure you are not inadvertently destroying useful caching behavior.
