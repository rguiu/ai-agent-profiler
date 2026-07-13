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

// For explicit-breakpoint providers (Anthropic/Bedrock): stripTools stays
// active on the steady-state path (prefix-safe from turn 1). Everything else
// destroys the native ~98-99% cache read rate.
//
// Anthropic's native cache achieves ~98-99% read rate on unmodified requests.
// ANY modification — even deterministic transforms — causes cache misses where
// bytes changed. On Opus 4.x the 5m write penalty ($6.25/MTok, 1.25× input) far
// exceeds any savings from smaller context ($0.50/MTok read rate) — a 12.5×
// read→write ratio. (Claude Code sends the 5m cache; the 1h cache writes at 20×.)
//
// Benchmarks (iterative-fix-plus, 70 requests, Opus 4.6 Bedrock):
//   no optimization:      99% read, 1% write  → $7.47
//   stableTruncate only:  95% read, 5% write  → $9.40 (+26%)
//   prefix-editing:       34% read, 66% write → $18.78 (+151%)
//
// Benchmark results (see OPTIMIZATION-FINDINGS.md) show that editing the cached
// prefix on explicit-cache providers costs more than it saves, so the full layer
// is disabled. Only stripTools (prefix-safe from turn 1) remains active through
// the base config.
export const EXPLICIT_CACHE_OVERRIDES: Partial<OptimizeConfig> = {
  dedup: false,
  truncate: false,
  stablePrefix: false,
  pruneStale: false,
  pruneStabilityWindow: 0,
  stableTruncate: false,
  shapeTestOutput: false,
  prefixProbe: false,
  frozenCompact: false,
  suppressReread: false,
  collapseSystem: false,
  pruneUnusedTools: false,
  insertBreakpoints: false,
  reorderVolatile: false,
  tailTruncate: false,
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
// Returns the appropriate override set, or `undefined` (base config unchanged).
export function overridesFor(
  profile: OptimizeProfile,
  provider: string,
): Partial<OptimizeConfig> | undefined {
  if (appliesCacheSafe(profile, provider)) return CACHE_SAFE_OVERRIDES;
  const family = cacheFamilyFor(provider);
  if (family === "explicit" && profile !== "default")
    return EXPLICIT_CACHE_OVERRIDES;
  return undefined;
}
