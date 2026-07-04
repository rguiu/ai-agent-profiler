import { z } from "zod";

export const providerSchema = z.object({
  upstream: z.url(),
});

export const serverSchema = z.object({
  port: z.number().int().positive().default(8080),
  host: z.string().default("127.0.0.1"),
});

export const sessionsSchema = z.object({
  idleTimeoutMs: z.number().int().positive().default(300_000),
});

export const configSchema = z.object({
  server: serverSchema.prefault({}),
  sessions: sessionsSchema.prefault({}),
  providers: z
    .record(z.string(), providerSchema)
    .refine((p) => Object.keys(p).length > 0, {
      message: "at least one provider must be configured",
    }),
  pricing: z.record(z.string(), z.unknown()).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
