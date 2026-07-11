import { describe, expect, it } from "vitest";
import { resolveOptimizeConfig } from "./proxy.js";
import { CACHE_SAFE_OVERRIDES } from "../optimize/index.js";

describe("resolveOptimizeConfig", () => {
  const base = { profile: "auto" as const, collapseSystem: true, dedup: true };

  it("applies cache-safe overrides for deepseek under auto", () => {
    const out = resolveOptimizeConfig(base, "deepseek");
    expect(out).toMatchObject(CACHE_SAFE_OVERRIDES);
    expect(out?.collapseSystem).toBe(false);
    expect(out?.pruneStale).toBe(false);
    expect(out?.pruneUnusedTools).toBe(false);
    expect(out?.dedup).toBe(true);
  });

  it("leaves non-prefix-cache providers untouched under auto", () => {
    const out = resolveOptimizeConfig(base, "anthropic");
    expect(out?.collapseSystem).toBe(true);
  });

  it("forces cache-safe for all providers under cache-safe profile", () => {
    const out = resolveOptimizeConfig(
      { ...base, profile: "cache-safe" },
      "anthropic",
    );
    expect(out?.collapseSystem).toBe(false);
  });

  it("leaves everything intact under default profile, even for deepseek", () => {
    const out = resolveOptimizeConfig(
      { ...base, profile: "default" },
      "deepseek",
    );
    expect(out?.collapseSystem).toBe(true);
  });

  it("defaults to auto when profile is unset", () => {
    const out = resolveOptimizeConfig({ collapseSystem: true }, "deepseek");
    expect(out?.collapseSystem).toBe(false);
  });
});
