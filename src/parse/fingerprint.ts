// Small, stable, non-crypto content hash (FNV-1a, 32-bit) used to fingerprint
// prefix segments (system prompt, tool definitions, messages) for cache
// stability analysis. We only need equality, not collision resistance against
// adversaries — content is never stored, only its hash (see
// docs/PREFIX-FINGERPRINTING.md).
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
