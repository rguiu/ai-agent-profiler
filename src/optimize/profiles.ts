// Provider optimization profiles.
//
// Different providers cache differently, so the optimize layer must apply
// different strategy sets per provider. Historically this lived as an ad-hoc
// `Set(["deepseek"])` plus an inline override object in the proxy; this module
// centralises the provider→strategy mapping in one typed place.
//
// Two axes:
//   1. The *profile* the operator selects (`auto` | `default` | `cache-safe`),
//      which decides WHETHER cache-safe overrides apply.
//   2. The provider's *cache family*, which decides whether `auto` treats it as
//      a prefix-cache provider needing those overrides.
//
// See docs/DEEPSEEK-CACHING.md (why prefix edits backfire on token-prefix caches)
// and docs/CLAUDE-CACHING.md (why Anthropic's explicit-breakpoint cache tolerates
// the full layer).

import { CACHE_SAFE_OVERRIDES, type OptimizeConfig } from "./layer.js";

// Operator-selected profile. Mirrors the config `[optimize].profile` enum.
//   auto       — apply cache-safe overrides only to prefix-cache providers.
//   default    — never apply overrides; run the full layer everywhere.
//   cache-safe — force cache-safe overrides for every provider.
export type OptimizeProfile = "auto" | "default" | "cache-safe";

// How a provider's upstream caches, which is what `auto` keys off.
//   prefix   — automatic token-prefix cache (DeepSeek/OpenAI-compatible). Any
//              edit to the cached prefix re-bills everything downstream, so the
//              prefix-editing strategies must be swapped for cache-safe ones.
//   explicit — client-placed `cache_control` breakpoints (Anthropic/Bedrock).
//              Tolerates the full token-reduction layer. See docs/CLAUDE-CACHING.md.
//   none     — no upstream prompt caching to protect; full layer is fine.
export type CacheFamily = "prefix" | "explicit" | "none";

// Registry of known providers → cache family. Unknown providers fall back to
// `none` (full layer, no overrides) — the historical default for anything not
// in the old PREFIX_CACHE_PROVIDERS set.
export const PROVIDER_CACHE_FAMILY: Readonly<Record<string, CacheFamily>> = {
  deepseek: "prefix",
  openai: "prefix",
  anthropic: "explicit",
  bedrock: "explicit",
  ollama: "none",
};

export function cacheFamilyFor(provider: string): CacheFamily {
  return PROVIDER_CACHE_FAMILY[provider] ?? "none";
}

// Whether the given profile applies cache-safe overrides for a provider.
// - "default": never.
// - "cache-safe": always.
// - "auto": only for prefix-cache providers.
export function appliesCacheSafe(
  profile: OptimizeProfile,
  provider: string,
): boolean {
  if (profile === "default") return false;
  if (profile === "cache-safe") return true;
  return cacheFamilyFor(provider) === "prefix";
}

// Resolve the effective strategy overrides for a provider under a profile.
// Returns the cache-safe override set when it applies, otherwise `undefined`
// (meaning: run the base config unchanged).
export function overridesFor(
  profile: OptimizeProfile,
  provider: string,
): Partial<OptimizeConfig> | undefined {
  return appliesCacheSafe(profile, provider) ? CACHE_SAFE_OVERRIDES : undefined;
}
