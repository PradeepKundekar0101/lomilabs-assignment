import { z } from "zod";

const required = z.string().min(1);

export const InfraEnvSchema = z.object({
  DATABASE_URL: required,
  REDIS_URL: required,
  S3_ENDPOINT: required,
  S3_BUCKET: required,
  S3_ACCESS_KEY: required,
  S3_SECRET_KEY: required,
});

export const ApiEnvSchema = InfraEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  EXPECTED_FIELDS_PATH: required,
});

export const SeedEnvSchema = InfraEnvSchema.extend({ FIXTURES_DIR: required });

/** Parses the environment with `schema`, or throws listing every missing or invalid variable. */
export function loadEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
