import { z } from "zod";

const required = z.string().min(1);
const positiveSeconds = (fallback: number) => z.coerce.number().positive().default(fallback);

export const WorkerEnvSchema = z.object({
  DATABASE_URL: required,
  REDIS_URL: required,
  S3_ENDPOINT: required,
  S3_BUCKET: required,
  S3_ACCESS_KEY: required,
  S3_SECRET_KEY: required,
  EXPECTED_FIELDS_PATH: required,
  LLM_MODEL: required,
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LEASE_SECONDS: positiveSeconds(60),
  RECONCILE_SECONDS: positiveSeconds(15),
});

/** Parses the environment with `schema`, or throws listing every missing or invalid variable. */
export function loadEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
