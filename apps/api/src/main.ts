import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDb } from "@lomi/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { createVersion, type CreateVersionDeps } from "./create-version.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = requireEnv("DATABASE_URL");
const redisUrl = requireEnv("REDIS_URL");
const s3Bucket = requireEnv("S3_BUCKET");
const port = Number(process.env.PORT ?? 3000);

const db = createDb(databaseUrl);

const s3 = new S3Client({
  endpoint: requireEnv("S3_ENDPOINT"),
  // MinIO ignores the region, but the SDK requires one.
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: requireEnv("S3_ACCESS_KEY"), secretAccessKey: requireEnv("S3_SECRET_KEY") },
});

// No offline queue: a PING while Redis is down fails at once instead of hanging the health check.
const redis = new Redis(redisUrl, { enableOfflineQueue: false, connectTimeout: 2000 });
redis.on("error", (err: NodeJS.ErrnoException) => console.error("redis error", err.code ?? err.message));

// Fail fast: with Redis down, queue.add rejects at once (the upload still succeeds and the row stays
// queued) instead of hanging the request until Redis is back. No offline queue covers Redis going down
// later; skipWaitingForReady covers the api starting while Redis is down, and needs skipVersionCheck,
// whose INFO call would otherwise fail that first connection for good.
const queue = new Queue("extraction", {
  connection: new Redis(redisUrl, { enableOfflineQueue: false }),
  skipWaitingForReady: true,
  skipVersionCheck: true,
});
queue.on("error", (err: NodeJS.ErrnoException) => console.error("queue error", err.code ?? err.message));

const versionDeps: CreateVersionDeps = {
  putObject: async (key, body, contentType) => {
    await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: body, ContentType: contentType }));
  },
  db,
  // jobId = versionId makes a repeated enqueue of the same version a no-op.
  enqueue: async (versionId) => void (await queue.add("extract", { versionId }, { jobId: versionId })),
};

const server = createApp({
  checks: {
    db: () => db.$queryRaw`SELECT 1`,
    redis: () => redis.ping(),
  },
  db,
  createVersion: (documentId, file, type) => createVersion(versionDeps, documentId, file, type),
}).listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void db.$disconnect();
  void queue.close();
  redis.disconnect();
});
