// Simple memoization utility
export function memoize(fn) {
  const cache = new Map();
  return function (...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = fn.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

// Example expensive function: sum of squares (O(n))
export function sumSquares(n) {
  if (!Number.isInteger(n) || n < 0)
    throw new Error("n must be a non-negative integer");
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += i * i;
  }
  return sum;
}

// Memoized version
export const memoizedSumSquares = memoize(sumSquares);
