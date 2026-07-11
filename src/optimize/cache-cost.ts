// Pure cache-cost math for DeepSeek's automatic prefix caching.
//
// DeepSeek matches a continuous token prefix starting at position 0, stored in
// 64-token units. Any tokens after the first point of divergence from the
// previous request are billed as cache misses (full input price); the matching
// prefix is billed at the (≈10× cheaper) cache-hit rate.
//
// This module is intentionally free of any JSON/message-shape or pricing
// knowledge — it operates on flattened prompt strings so it can be unit-tested
// in isolation. Pricing is applied by the caller via parse.computeCost.

export const CACHE_BLOCK_TOKENS = 64;

export interface TurnCache {
  promptTokens: number;
  hitTokens: number;
  missTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Length of the common character prefix of two strings.
function commonPrefixChars(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// Cached prefix length in tokens: the shared character prefix converted to
// tokens and floored to the nearest storage unit (a partial trailing unit does
// not cache).
export function commonPrefixTokens(
  a: string,
  b: string,
  blockSize: number = CACHE_BLOCK_TOKENS,
): number {
  const tokens = Math.floor(commonPrefixChars(a, b) / 4);
  return Math.floor(tokens / blockSize) * blockSize;
}

// Split one request's flattened prompt into hit/miss tokens given the previous
// request's flattened prompt. A cold prefix (prev === null) is all miss.
export function turnCache(
  prev: string | null,
  current: string,
  blockSize: number = CACHE_BLOCK_TOKENS,
): TurnCache {
  const promptTokens = estimateTokens(current);
  const hitTokens =
    prev === null
      ? 0
      : Math.min(commonPrefixTokens(prev, current, blockSize), promptTokens);
  return { promptTokens, hitTokens, missTokens: promptTokens - hitTokens };
}
