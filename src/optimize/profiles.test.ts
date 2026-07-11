import { describe, expect, it } from "vitest";
import {
  cacheFamilyFor,
  appliesCacheSafe,
  overridesFor,
  PROVIDER_CACHE_FAMILY,
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
  it("returns the cache-safe override set when it applies", () => {
    expect(overridesFor("auto", "deepseek")).toBe(CACHE_SAFE_OVERRIDES);
    expect(overridesFor("cache-safe", "anthropic")).toBe(CACHE_SAFE_OVERRIDES);
  });

  it("returns undefined when overrides do not apply", () => {
    expect(overridesFor("auto", "anthropic")).toBeUndefined();
    expect(overridesFor("default", "deepseek")).toBeUndefined();
  });
});

describe("PROVIDER_CACHE_FAMILY registry", () => {
  it("keeps deepseek as prefix (the historical PREFIX_CACHE_PROVIDERS member)", () => {
    expect(PROVIDER_CACHE_FAMILY.deepseek).toBe("prefix");
  });
});
