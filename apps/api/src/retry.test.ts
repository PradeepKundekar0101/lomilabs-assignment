import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createDb, type PrismaClient, type VersionStatus } from "@lomi/db";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryDocument } from "./retry.js";
import { enqueueTo, extractionQueue } from "./services.js";

// A dedicated test database and Redis database (see spec 007), e.g.
// TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test TEST_REDIS_URL=redis://127.0.0.1:6379/1
const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!dbUrl || !redisUrl)("retryDocument against Postgres and Redis", () => {
  let db: PrismaClient;
  let connection: Redis;
  let queue: ReturnType<typeof extractionQueue>;
  let enqueue: (versionId: string) => Promise<void>;
  const queueName = `extraction-test-${randomUUID()}`;
  const documentIds: string[] = [];

  beforeAll(async () => {
    db = createDb(dbUrl!);
    connection = new Redis(redisUrl!, { enableOfflineQueue: false });
    await once(connection, "ready");
    queue = extractionQueue(connection, queueName);
    enqueue = enqueueTo(queue);
  });

  afterAll(async () => {
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    await queue.obliterate({ force: true });
    await queue.close();
    connection.disconnect();
    await db.$disconnect();
  });

  async function seedVersion(status: VersionStatus) {
    const doc = await db.document.create({ data: { id: `test-${randomUUID()}`, type: "invoice", title: "retry test" } });
    const failed = status === "failed" ? { attempts: 3, error: "too_many_attempts: 3 attempts did not finish" } : {};
    const version = await db.documentVersion.create({
      data: { documentId: doc.id, versionNo: 1, storageKey: "pdfs/test.pdf", sha256: "test", sizeBytes: 1, mimeType: "application/pdf", status, ...failed },
    });
    await db.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    documentIds.push(doc.id);
    return { documentId: doc.id, versionId: version.id };
  }
  const version = (id: string) => db.documentVersion.findUniqueOrThrow({ where: { id } });

  it("requeues a failed version, even though its earlier job with the same id completed", async () => {
    const { documentId, versionId } = await seedVersion("failed");
    // The version's first job, finished the way the worker finishes it.
    await enqueue(versionId);
    const workerConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const worker = new Worker(queueName, async () => {}, { connection: workerConnection });
    await once(worker, "completed");
    await worker.close();
    workerConnection.disconnect();

    expect(await retryDocument({ db, enqueue }, documentId)).toEqual({ versionId });
    expect(await version(versionId)).toMatchObject({ status: "queued", attempts: 0, error: null, leaseUntil: null });
    // A kept completed job would make BullMQ ignore this add, and the retry would never run.
    expect(await queue.getJobState(versionId)).toBe("waiting");
  });

  it("leaves a version that did not fail alone, and tells an unknown document apart", async () => {
    const { documentId, versionId } = await seedVersion("extracted");
    const before = await version(versionId);
    expect(await retryDocument({ db, enqueue }, documentId)).toBe("not_failed");
    expect(await version(versionId)).toEqual(before);
    expect(await retryDocument({ db, enqueue }, `test-${randomUUID()}`)).toBe("not_found");
  });

  it("still requeues when the enqueue fails, for the reconciler to pick up", async () => {
    const { documentId, versionId } = await seedVersion("failed");
    const down = async () => {
      throw new Error("redis down");
    };
    expect(await retryDocument({ db, enqueue: down }, documentId)).toEqual({ versionId });
    expect((await version(versionId)).status).toBe("queued");
  });
});
