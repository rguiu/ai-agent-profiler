import { z } from "zod";

export const providerSchema = z.object({
  upstream: z.url(),
  apiPath: z.string().optional(),
});

export const serverSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default("127.0.0.1"),
  // A stalled TCP/TLS handshake used to hold an upstream slot until the OS gave
  // up (~75s) or the request timeout fired (120s). Failed handshakes are routine
  // on flaky/VPN networks, so fail them fast and free the slot.
  connectTimeoutMs: z.number().int().positive().default(15_000),
  // Socket inactivity cap once the request is on the wire. Extended thinking and
  // large tool-use payloads can pause well over a minute before the next chunk.
  upstreamTimeoutMs: z.number().int().positive().default(120_000),
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
  cacheWritePerMTok: z.number().nonnegative().optional(),
});

export const throttleSchema = z.object({
  // Per-provider concurrency cap. Every request holds a slot for the whole
  // response stream, so this bounds how many agents can talk at once before the
  // proxy starts queueing them. Several agents sharing one proxy routinely
  // exceed the default, so raise it (the proxy logs when it queues).
  maxConcurrent: z.number().int().positive().default(8),
  maxQueued: z.number().int().positive().default(64),
  timeoutMs: z.number().int().positive().default(180_000),
});

// Full-text search index over captured traces (search.sqlite). Indexing runs
// off the hot path; disable to skip the background tick entirely.
export const searchSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().positive().default(5000),
  batchSize: z.number().int().positive().default(50),
});

export const configSchema = z.object({
  server: serverSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  storage: storageSchema.prefault({}),
  throttle: throttleSchema.prefault({}),
  search: searchSchema.prefault({}),
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
