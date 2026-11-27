import { readFileSync } from "node:fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createLlm, ExpectedFieldsSchema } from "@lomi/core";
import { createDb, DocumentType } from "@lomi/db";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { processVersion } from "./extract.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fields = ExpectedFieldsSchema.parse(JSON.parse(readFileSync(requireEnv("EXPECTED_FIELDS_PATH"), "utf8")));
for (const type of Object.values(DocumentType)) {
  if (!fields[type]) throw new Error(`expected fields file has no entry for document type ${type}`);
}

const model = requireEnv("LLM_MODEL");
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
const s3Bucket = requireEnv("S3_BUCKET");
const db = createDb(requireEnv("DATABASE_URL"));
const s3 = new S3Client({
  endpoint: requireEnv("S3_ENDPOINT"),
  // MinIO ignores the region, but the SDK requires one.
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: requireEnv("S3_ACCESS_KEY"), secretAccessKey: requireEnv("S3_SECRET_KEY") },
});

const deps = {
  db,
  getObject: async (key: string) => {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: key }));
    if (!Body) throw new Error(`object ${key} has no body`);
    return Body.transformToByteArray();
  },
  llm: createLlm(model),
  model,
  fields,
};

// BullMQ workers need maxRetriesPerRequest: null so blocking commands survive reconnects.
const connection = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });

const worker = new Worker(
  "extraction",
  async (job) => {
    const { versionId } = job.data as { versionId?: unknown };
    if (typeof versionId !== "string") return void console.error(`job ${job.id}: no versionId, skipped`);
    await processVersion(deps, versionId);
  },
  { connection, concurrency },
);

worker.on("ready", () => console.log(`worker ready (model ${model}, concurrency ${concurrency})`));
worker.on("error", (err: NodeJS.ErrnoException) => console.error("worker error", err.code ?? err.message));

process.on("SIGTERM", () => void worker.close().then(() => Promise.all([connection.quit(), db.$disconnect()])));
