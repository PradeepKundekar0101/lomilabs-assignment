import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDb } from "@lomi/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { CreateVersionDeps } from "./create-version.js";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The database, object storage and queue that `createVersion` writes to, configured from the environment. */
export function createServices() {
  const redisUrl = requireEnv("REDIS_URL");
  const s3Bucket = requireEnv("S3_BUCKET");
  const db = createDb(requireEnv("DATABASE_URL"));

  const s3 = new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    // MinIO ignores the region, but the SDK requires one.
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: requireEnv("S3_ACCESS_KEY"), secretAccessKey: requireEnv("S3_SECRET_KEY") },
  });

  // Fail fast: with Redis down, queue.add rejects at once (the upload still succeeds and the row stays
  // queued) instead of hanging the request until Redis is back. No offline queue covers Redis going down
  // later; skipWaitingForReady covers the api starting while Redis is down, and needs skipVersionCheck,
  // whose INFO call would otherwise fail that first connection for good.
  const queueConnection = new Redis(redisUrl, { enableOfflineQueue: false });
  const queue = new Queue("extraction", { connection: queueConnection, skipWaitingForReady: true, skipVersionCheck: true });
  queue.on("error", (err: NodeJS.ErrnoException) => console.error("queue error", err.code ?? err.message));

  const versionDeps: CreateVersionDeps = {
    putObject: async (key, body, contentType) => {
      await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    db,
    // jobId = versionId makes a repeated enqueue of the same version a no-op.
    enqueue: async (versionId) => void (await queue.add("extract", { versionId }, { jobId: versionId })),
  };

  return { db, queue, queueConnection, versionDeps, redisUrl };
}
