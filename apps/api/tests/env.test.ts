import { describe, expect, it } from "vitest";
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
    expect(loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "fields.json" })).toEqual({ ...infra, EXPECTED_FIELDS_PATH: "fields.json", PORT: 3000 });
    expect(loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "fields.json", PORT: "8080" }).PORT).toBe(8080);
  });

  it("lists every missing or invalid variable, an empty one included", () => {
    const load = () => loadEnv(SeedEnvSchema, { ...infra, S3_BUCKET: "", DATABASE_URL: undefined });
    expect(load).toThrow(/S3_BUCKET/);
    expect(load).toThrow(/DATABASE_URL/);
    expect(load).toThrow(/FIXTURES_DIR/);
    expect(() => loadEnv(ApiEnvSchema, { ...infra, EXPECTED_FIELDS_PATH: "f", PORT: "http" })).toThrow(/PORT/);
  });
});
