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

/**
 * The extraction queue, with the same job options as the worker's (apps/worker/src/reconciler.ts): finished
 * jobs must leave Redis, or BullMQ silently ignores re-adding their jobId and a retry never runs.
 * No offline queue covers Redis going down later; skipWaitingForReady covers starting while Redis is down,
 * and needs skipVersionCheck, whose INFO call would otherwise fail that first connection for good.
 */
export const extractionQueue = (connection: Redis, name = "extraction") =>
  new Queue(name, {
    connection,
    skipWaitingForReady: true,
    skipVersionCheck: true,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 1 },
  });

/** jobId = versionId makes a repeated enqueue of a waiting or active version a no-op. */
export const enqueueTo = (queue: Queue) => async (versionId: string) => void (await queue.add("extract", { versionId }, { jobId: versionId }));

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
  // queued) instead of hanging the request until Redis is back.
  const queueConnection = new Redis(redisUrl, { enableOfflineQueue: false });
  const queue = extractionQueue(queueConnection);
  queue.on("error", (err: NodeJS.ErrnoException) => console.error("queue error", err.code ?? err.message));

  const versionDeps: CreateVersionDeps = {
    putObject: async (key, body, contentType) => {
      await s3.send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    db,
    enqueue: enqueueTo(queue),
  };

  return { db, queue, queueConnection, versionDeps };
}
