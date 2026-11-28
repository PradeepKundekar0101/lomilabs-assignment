import { describe, expect, it } from "vitest";
import { s3Config } from "../src/infra.js";
import { ApiEnvSchema, loadEnv, SeedEnvSchema } from "../src/schemas/env.schema.js";

const infra = {
  DATABASE_URL: "postgres://lomi:lomi@127.0.0.1:5433/lomi",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_BUCKET: "documents",
  S3_ACCESS_KEY: "minio",
  S3_SECRET_KEY: "minio123",
};

describe("loadEnv", () => {
  it("parses the api's environment, with PORT as a number defaulting to 3000", () => {
    expect(loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "fields.json" })).toEqual({ ...infra, EXPECTED_FIELDS_PATH: "fields.json", PORT: 3000, AWS_REGION: "us-east-1" });
    expect(loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "fields.json", PORT: "8080" }).PORT).toBe(8080);
  });

  it("lists every missing or invalid variable, an empty one included", () => {
    const load = () => loadEnv(SeedEnvSchema, { ...infra, S3_BUCKET: "", DATABASE_URL: undefined });
    expect(load).toThrow(/S3_BUCKET/);
    expect(load).toThrow(/DATABASE_URL/);
    expect(load).toThrow(/FIXTURES_DIR/);
    expect(() => loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "f", PORT: "http" })).toThrow(/PORT/);
  });

  it("accepts no S3 endpoint or keys (AWS: the task role), but not one key without the other", () => {
    const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, ...aws } = infra;
    const env = { ...aws, EXPECTED_FIELDS_PATH: "f", AWS_REGION: "ap-south-1", WEB_ORIGIN: "https://lomi.vercel.app" };
    expect(loadEnv(ApiEnvSchema, env)).toMatchObject({ AWS_REGION: "ap-south-1", WEB_ORIGIN: "https://lomi.vercel.app" });
    expect(() => loadEnv(ApiEnvSchema, { ...env, S3_ACCESS_KEY })).toThrow(/S3_SECRET_KEY/);
    expect(() => loadEnv(SeedEnvSchema, { ...aws, FIXTURES_DIR: "f", S3_SECRET_KEY })).toThrow(/S3_ACCESS_KEY and S3_SECRET_KEY/);
    expect(() => loadEnv(ApiEnvSchema, { ...env, WEB_ORIGIN: "vercel" })).toThrow(/WEB_ORIGIN/);
    expect(S3_ENDPOINT).toBeDefined();
  });

  it("takes Cloud Storage's GCS_BUCKET instead of S3_BUCKET, but never both or neither", () => {
    const { S3_BUCKET, ...noBucket } = infra;
    const env = { ...noBucket, EXPECTED_FIELDS_PATH: "f" };
    expect(loadEnv(ApiEnvSchema, { ...env, GCS_BUCKET: "pdfs" }).GCS_BUCKET).toBe("pdfs");
    expect(() => loadEnv(ApiEnvSchema, env)).toThrow(/exactly one of S3_BUCKET and GCS_BUCKET/);
    expect(() => loadEnv(ApiEnvSchema, { ...env, S3_BUCKET, GCS_BUCKET: "pdfs" })).toThrow(/exactly one/);
  });
});

describe("s3Config", () => {
  it("uses MinIO's endpoint, path-style URLs and keys when they are set", () => {
    expect(s3Config({ ...infra, AWS_REGION: "us-east-1" })).toEqual({
      region: "us-east-1",
      endpoint: infra.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: infra.S3_ACCESS_KEY, secretAccessKey: infra.S3_SECRET_KEY },
    });
  });
  it("leaves endpoint and credentials to the SDK on AWS", () => {
    expect(s3Config({ AWS_REGION: "ap-south-1" })).toEqual({ region: "ap-south-1" });
  });
});
