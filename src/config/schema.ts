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

export const modelPricingSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheInputPerMTok: z.number().nonnegative().optional(),
});

export const configSchema = z.object({
  server: serverSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  storage: storageSchema.prefault({}),
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
