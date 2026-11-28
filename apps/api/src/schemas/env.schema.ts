import { z } from "zod";

const required = z.string().min(1);

// PDFs go to S3_BUCKET (MinIO in compose, whose endpoint and keys these are; on AWS the role's credentials)
// or to GCS_BUCKET (Cloud Storage, as the Cloud Run service account).
export const InfraEnvSchema = z.object({
  DATABASE_URL: required,
  REDIS_URL: required,
  S3_ENDPOINT: required.optional(),
  S3_BUCKET: required.optional(),
  GCS_BUCKET: required.optional(),
  S3_ACCESS_KEY: required.optional(),
  S3_SECRET_KEY: required.optional(),
  AWS_REGION: required.default("us-east-1"),
});

// Zod 4 cannot extend a refined object, so each entry point's schema adds these refinements last.
const bothKeysOrNeither = (env: { S3_ACCESS_KEY?: string; S3_SECRET_KEY?: string }) => !env.S3_ACCESS_KEY === !env.S3_SECRET_KEY;
const bothKeysError = { message: "set both S3_ACCESS_KEY and S3_SECRET_KEY, or neither", path: ["S3_SECRET_KEY"] };
const oneBucket = (env: { S3_BUCKET?: string; GCS_BUCKET?: string }) => !env.S3_BUCKET !== !env.GCS_BUCKET;
const oneBucketError = { message: "set exactly one of S3_BUCKET and GCS_BUCKET", path: ["S3_BUCKET"] };

export const ApiEnvSchema = InfraEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  EXPECTED_FIELDS_PATH: required,
  // The review UI's origin when it is served from elsewhere (Vercel); compose serves it same-origin through nginx.
  WEB_ORIGIN: z.url().optional(),
})
  .refine(bothKeysOrNeither, bothKeysError)
  .refine(oneBucket, oneBucketError);

export const SeedEnvSchema = InfraEnvSchema.extend({ FIXTURES_DIR: required })
  .refine(bothKeysOrNeither, bothKeysError)
  .refine(oneBucket, oneBucketError);

/** Parses the environment with `schema`, or throws listing every missing or invalid variable. */
export function loadEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`invalid environment:\n${z.prettifyError(result.error)}`);
  return result.data;
}
