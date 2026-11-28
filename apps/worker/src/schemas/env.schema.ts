import { z } from "zod";

const required = z.string().min(1);
const positiveSeconds = (fallback: number) => z.coerce.number().positive().default(fallback);

// PDFs come from S3_BUCKET (MinIO in compose, whose endpoint and keys these are; on AWS the role's credentials)
// or from GCS_BUCKET (Cloud Storage, as the Cloud Run service account).
export const WorkerEnvSchema = z.object({
  DATABASE_URL: required,
  REDIS_URL: required,
  S3_ENDPOINT: required.optional(),
  S3_BUCKET: required.optional(),
  GCS_BUCKET: required.optional(),
  S3_ACCESS_KEY: required.optional(),
  S3_SECRET_KEY: required.optional(),
  AWS_REGION: required.default("us-east-1"),
  EXPECTED_FIELDS_PATH: required,
  LLM_MODEL: required,
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LEASE_SECONDS: positiveSeconds(60),
  RECONCILE_SECONDS: positiveSeconds(15),
}).refine((env) => !env.S3_ACCESS_KEY === !env.S3_SECRET_KEY, {
  message: "set both S3_ACCESS_KEY and S3_SECRET_KEY, or neither",
  path: ["S3_SECRET_KEY"],
}).refine((env) => !env.S3_BUCKET !== !env.GCS_BUCKET, {
  message: "set exactly one of S3_BUCKET and GCS_BUCKET",
  path: ["S3_BUCKET"],
});

/** Parses the environment with `schema`, or throws listing every missing or invalid variable. */
export function loadEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
