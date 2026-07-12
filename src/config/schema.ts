import { z } from "zod";

export const providerSchema = z.object({
  upstream: z.url(),
  apiPath: z.string().optional(),
});

export const serverSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default("127.0.0.1"),
});

export const sessionsSchema = z.object({
  idleTimeoutMs: z.number().int().positive().default(300_000),
});

export const storageSchema = z.object({
  dir: z.string().default("data"),
});

export const optimizeSchema = z.object({
  enabled: z.boolean().default(false),
  // "auto" applies cache-safe overrides for prefix-caching providers (deepseek);
  // "cache-safe" forces them for all providers; "default" uses the full layer
  // (tuned for Anthropic explicit cache breakpoints).
  profile: z.enum(["auto", "default", "cache-safe"]).default("auto"),
  dedup: z.boolean().default(true),
  truncate: z.boolean().default(true),
  stablePrefix: z.boolean().default(true),
  pruneStale: z.boolean().default(true),
  stableTruncate: z.boolean().default(false),
  shapeTestOutput: z.boolean().default(false),
  prefixProbe: z.boolean().default(false),
  frozenCompact: z.boolean().default(false),
  suppressReread: z.boolean().default(true),
  collapseSystem: z.boolean().default(true),
  pruneUnusedTools: z.boolean().default(true),
  insertBreakpoints: z.boolean().default(false),
  reorderVolatile: z.boolean().default(false),
  truncateThreshold: z.number().int().positive().default(4096),
  pruneAfterTurns: z.number().int().positive().default(6),
  suppressWithinTurns: z.number().int().positive().default(2),
  pruneUnusedToolsAfter: z.number().int().positive().default(10),
  compactThreshold: z.number().int().positive().default(60000),
  compactKeepTail: z.number().int().positive().default(20),
});

export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});

export const throttleSchema = z.object({
  maxConcurrent: z.number().int().positive().default(8),
  maxQueued: z.number().int().positive().default(64),
  timeoutMs: z.number().int().positive().default(180_000),
});

export const configSchema = z.object({
  server: serverSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  storage: storageSchema.prefault({}),
  optimize: optimizeSchema.prefault({}),
  throttle: throttleSchema.prefault({}),
  providers: z
    .record(z.string(), providerSchema)
    .refine((p) => Object.keys(p).length > 0, {
      message: "at least one provider must be configured",
    }),
  pricing: z.record(z.string(), modelPricingSchema).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelPricing = z.infer<typeof modelPricingSchema>;
export type OptimizeSettings = z.infer<typeof optimizeSchema>;
