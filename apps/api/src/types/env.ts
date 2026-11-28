import type { z } from "zod";
import type { ApiEnvSchema, InfraEnvSchema, SeedEnvSchema } from "../schemas/env.schema.js";

/** The database, Redis and object storage settings every entry point needs. */
export type InfraEnv = z.infer<typeof InfraEnvSchema>;
export type ApiEnv = z.infer<typeof ApiEnvSchema>;
export type SeedEnv = z.infer<typeof SeedEnvSchema>;
