import { describe, expect, it } from "vitest";
import {
  cacheFamilyFor,
  appliesCacheSafe,
  overridesFor,
  PROVIDER_CACHE_FAMILY,
  EXPLICIT_CACHE_OVERRIDES,
} from "./profiles.js";
import { CACHE_SAFE_OVERRIDES } from "./layer.js";

describe("cacheFamilyFor", () => {
  it("classifies known prefix-cache providers", () => {
    expect(cacheFamilyFor("deepseek")).toBe("prefix");
    expect(cacheFamilyFor("openai")).toBe("prefix");
  });

  it("classifies explicit-breakpoint providers", () => {
    expect(cacheFamilyFor("anthropic")).toBe("explicit");
    expect(cacheFamilyFor("bedrock")).toBe("explicit");
  });

  it("falls back to none for unknown providers", () => {
    expect(cacheFamilyFor("some-new-provider")).toBe("none");
  });
});

describe("appliesCacheSafe", () => {
  it("auto applies only to prefix-cache providers", () => {
    expect(appliesCacheSafe("auto", "deepseek")).toBe(true);
    expect(appliesCacheSafe("auto", "openai")).toBe(true);
    expect(appliesCacheSafe("auto", "anthropic")).toBe(false);
    expect(appliesCacheSafe("auto", "bedrock")).toBe(false);
    expect(appliesCacheSafe("auto", "unknown")).toBe(false);
  });

  it("default never applies", () => {
    expect(appliesCacheSafe("default", "deepseek")).toBe(false);
    expect(appliesCacheSafe("default", "anthropic")).toBe(false);
  });

  it("cache-safe always applies", () => {
    expect(appliesCacheSafe("cache-safe", "deepseek")).toBe(true);
    expect(appliesCacheSafe("cache-safe", "anthropic")).toBe(true);
    expect(appliesCacheSafe("cache-safe", "unknown")).toBe(true);
  });
});

describe("overridesFor", () => {
  it("returns cache-safe overrides for prefix-cache providers", () => {
    expect(overridesFor("auto", "deepseek")).toBe(CACHE_SAFE_OVERRIDES);
    expect(overridesFor("cache-safe", "anthropic")).toBe(CACHE_SAFE_OVERRIDES);
  });

  it("returns explicit-cache overrides for explicit providers on auto", () => {
    expect(overridesFor("auto", "anthropic")).toBe(EXPLICIT_CACHE_OVERRIDES);
    expect(overridesFor("auto", "bedrock")).toBe(EXPLICIT_CACHE_OVERRIDES);
    // Explicit-cache overrides disable everything to preserve native cache
    expect(overridesFor("auto", "bedrock")).toHaveProperty(
      "pruneStale",
      false,
    );
    expect(overridesFor("auto", "bedrock")).toHaveProperty(
      "tailTruncate",
      true,
    );
  });

  it("returns explicit-cache overrides for cache-safe on explicit providers", () => {
    // cache-safe forces CACHE_SAFE_OVERRIDES (which disables prefix-editing)
    // This takes priority over explicit cache overrides
    expect(overridesFor("cache-safe", "bedrock")).toBe(CACHE_SAFE_OVERRIDES);
  });

  it("returns undefined for default profile (never overrides)", () => {
    expect(overridesFor("default", "deepseek")).toBeUndefined();
    expect(overridesFor("default", "anthropic")).toBeUndefined();
    expect(overridesFor("default", "ollama")).toBeUndefined();
  });

  it("returns undefined for none-family providers on auto", () => {
    expect(overridesFor("auto", "ollama")).toBeUndefined();
    expect(overridesFor("auto", "unknown")).toBeUndefined();
  });
});

describe("PROVIDER_CACHE_FAMILY registry", () => {
  it("keeps deepseek as prefix (the historical PREFIX_CACHE_PROVIDERS member)", () => {
    expect(PROVIDER_CACHE_FAMILY.deepseek).toBe("prefix");
  });
});
