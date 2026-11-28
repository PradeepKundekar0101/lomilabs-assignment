import { PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { gcsBucket } from "@lomi/core";
import { createDb } from "@lomi/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { InfraEnv } from "./types/env.js";
import type { CreateVersionDeps } from "./types/versions.js";

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

/** MinIO (compose) sets an endpoint, path-style URLs and keys; on AWS none is set and the default chain finds the role. */
export const s3Config = (env: Pick<InfraEnv, "S3_ENDPOINT" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "AWS_REGION">): S3ClientConfig => ({
  region: env.AWS_REGION,
  ...(env.S3_ENDPOINT && { endpoint: env.S3_ENDPOINT, forcePathStyle: true }),
  ...(env.S3_ACCESS_KEY && env.S3_SECRET_KEY && { credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } }),
});

/** The database, object storage and queue clients, and the `createVersion` dependencies built on them. */
export function createInfra(env: InfraEnv) {
  const db = createDb(env.DATABASE_URL);

  const s3 = new S3Client(s3Config(env));
  const gcs = env.GCS_BUCKET ? gcsBucket(env.GCS_BUCKET) : undefined;

  // Fail fast: with Redis down, queue.add rejects at once (the upload still succeeds and the row stays
  // queued) instead of hanging the request until Redis is back.
  const queueConnection = new Redis(env.REDIS_URL, { enableOfflineQueue: false });
  const queue = extractionQueue(queueConnection);
  queue.on("error", (err: NodeJS.ErrnoException) => console.error("queue error", err.code ?? err.message));

  const versionDeps: CreateVersionDeps = {
    putObject: async (key, body, contentType) => {
      if (gcs) return gcs.put(key, body, contentType);
      await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
    },
    db,
    enqueue: enqueueTo(queue),
  };

  return { db, queue, queueConnection, versionDeps };
}
