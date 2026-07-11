import { memoize } from '../src/memo.js';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

describe('memoize', () => {
  it('should cache results for same arguments', () => {
    let callCount = 0;
    function sumSquares(n) {
      callCount++;
      if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer');
      let sum = 0;
      for (let i = 1; i <= n; i++) {
        sum += i * i;
      }
      return sum;
    }
    const memoized = memoize(sumSquares);

    // First call
    const result1 = memoized(10);
    const callsAfterFirst = callCount;

    // Second call with same argument should not increase call count
    const result2 = memoized(10);
    const callsAfterSecond = callCount;

    assert.strictEqual(result1, result2);
    assert.strictEqual(callsAfterSecond, callsAfterFirst, 'Second call should not invoke the original function');
  });

  it('should produce correct sum of squares', () => {
    let callCount = 0;
    function sumSquares(n) {
      callCount++;
      if (!Number.isInteger(n) || n < 0) throw new Error('n must be a non-negative integer');
      let sum = 0;
      for (let i = 1; i <= n; i++) {
        sum += i * i;
      }
      return sum;
    }
    const memoized = memoize(sumSquares);

    // Known values: sum of squares formula n(n+1)(2n+1)/6
    const testCases = [
      { n: 0, expected: 0 },
      { n: 1, expected: 1 },
      { n: 2, expected: 5 }, // 1+4
      { n: 3, expected: 14 }, // 1+4+9
      { n: 10, expected: 385 } // sum of squares up to 10
    ];
    for (const { n, expected } of testCases) {
      assert.strictEqual(memoized(n), expected);
    }
    // After computing up to 10, call count should be number of distinct n values (0,1,2,3,10) = 5
    assert.strictEqual(callCount, 5);
  });
});