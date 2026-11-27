import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ExpectedFieldsSchema, type Llm, type LlmField } from "@lomi/core";
import { createDb, type PrismaClient, type VersionStatus } from "@lomi/db";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { processVersion } from "./extract.js";
import { enqueueVersions, extractionQueue, reconcile, startReconciler } from "./reconciler.js";

// A dedicated test database and Redis database (see spec 007), e.g.
// TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test TEST_REDIS_URL=redis://127.0.0.1:6379/1
const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

// Short timings so a lost lease, a stalled job and a reconcile all happen within a second or two. As in
// production (60 s lease, 30 s BullMQ lock), a dead worker's job comes back from BullMQ's stalled check
// before its lease expires, so the claim refuses it and only the reconciler can resume the version.
const LEASE_SECONDS = 1.5;
const RECONCILE_SECONDS = 0.2;
const BULL_TIMINGS = { lockDuration: 500, stalledInterval: 250 };

const fixture = (path: string) => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url));
const fields = ExpectedFieldsSchema.parse(JSON.parse(fixture("expected-fields.json").toString()));
const invoicePdf = new Uint8Array(fixture("documents/invoice-001.pdf"));
const invoiceAnswer: LlmField[] = [
  { key: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", reason: null },
  { key: "issue_date", value: "2025-09-14", evidence: "Issue Date: 2025-09-14", reason: null },
  { key: "due_date", value: "2025-10-14", evidence: "Due Date: 2025-10-14", reason: null },
  { key: "vendor_name", value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
  { key: "total_amount", value: "$5,230.29", evidence: "Total Due:   $5,230.29", reason: null },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});

/** A fake model that answers after `ms` (Infinity: never), or once released. */
function slowLlm(ms = 50) {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const llm: Llm = async () => {
    entered();
    await (ms === Infinity ? released : Promise.race([sleep(ms), released]));
    return { raw: '{"fake":true}', text: JSON.stringify({ fields: invoiceAnswer }), stopReason: "end_turn", tokensIn: 100, tokensOut: 50 };
  };
  return { llm, started, release };
}

// Any property of a dead client is this: every call hangs forever.
const hang: unknown = new Proxy(never, { get: () => hang });

describe.skipIf(!dbUrl || !redisUrl)("extraction resilience against Postgres and Redis", { timeout: 30_000 }, () => {
  let db: PrismaClient;
  let redis: Redis;
  let queue: ReturnType<typeof extractionQueue>;
  const queueName = `extraction-test-${randomUUID()}`;
  // Other test files share the test database, so reconcilers here only enqueue versions these tests made.
  const mine = new Set<string>();
  const documentIds: string[] = [];
  const running: { stop: () => Promise<void> }[] = [];

  /**
   * One worker process, as `main.ts` runs it: a BullMQ worker, a reconciler and its own Postgres client.
   * `kill` is a SIGKILL as Postgres and Redis see it: no lock renewal, no heartbeat, no further writes,
   * and the attempt in flight never finishes.
   */
  function startWorker(llm: (self: { kill: () => Promise<void> }) => Llm) {
    const pg = createDb(dbUrl!);
    let dead = false;
    const db = new Proxy(pg, {
      get: (target, key) => {
        if (dead) return hang;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const self = {
      kill: async () => {
        dead = true;
        stopReconciler();
        await worker.close(true);
        connection.disconnect();
      },
      stop: async () => {
        stopReconciler();
        if (!dead) await worker.close();
        connection.disconnect();
        await pg.$disconnect();
      },
    };
    const deps = { db, getObject: async () => invoicePdf, llm: llm(self), model: "fake-model", fields, leaseSeconds: LEASE_SECONDS };
    const worker = new Worker(queueName, async (job) => void (await processVersion(deps, job.data.versionId)), {
      connection,
      concurrency: 2,
      ...BULL_TIMINGS,
    });
    worker.on("error", () => {}); // BullMQ bookkeeping errors after a flush are expected; Postgres decides the outcome.
    const stopReconciler = startReconciler(
      () => reconcile(db, (ids) => enqueueVersions(queue, ids.filter((id) => mine.has(id)))),
      RECONCILE_SECONDS,
    );
    running.push(self);
    return self;
  }

  async function seedInvoice(status: VersionStatus = "queued", over: { attempts?: number; error?: string } = {}) {
    const doc = await db.document.create({ data: { id: `test-${randomUUID()}`, type: "invoice", title: "resilience test" } });
    const version = await db.documentVersion.create({
      data: { documentId: doc.id, versionNo: 1, storageKey: "pdfs/test.pdf", sha256: "test", sizeBytes: invoicePdf.length, mimeType: "application/pdf", status, ...over },
    });
    await db.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    documentIds.push(doc.id);
    mine.add(version.id);
    return version.id;
  }

  const enqueue = (...ids: string[]) => enqueueVersions(queue, ids);

  /** FLUSHALL as far as this queue can tell: every Redis key it owns is gone. Other test files share the Redis. */
  async function flushRedis() {
    const keys = await redis.keys(`bull:${queueName}:*`);
    if (keys.length) await redis.del(...keys);
  }

  const state = async (versionId: string) => ({
    version: await db.documentVersion.findUniqueOrThrow({ where: { id: versionId } }),
    values: await db.extractedValue.findMany({ where: { versionId }, orderBy: { fieldKey: "asc" }, include: { reviews: true } }),
    runs: await db.extractionRun.findMany({ where: { versionId }, orderBy: { startedAt: "asc" } }),
  });

  async function waitForStatus(versionId: string, status: VersionStatus, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await state(versionId);
      if (s.version.status === status) return s;
      if (Date.now() > deadline) throw new Error(`version stayed ${s.version.status} (attempts ${s.version.attempts}), expected ${status}`);
      await sleep(100);
    }
  }

  beforeAll(() => {
    db = createDb(dbUrl!);
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    queue = extractionQueue(redis, queueName);
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((w) => w.stop()));
  });

  afterAll(async () => {
    const inDocs = { version: { documentId: { in: documentIds } } };
    await db.review.deleteMany({ where: { value: inDocs } });
    await db.extractedValue.deleteMany({ where: inDocs });
    await db.extractionRun.deleteMany({ where: inDocs });
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    await queue.obliterate({ force: true });
    await queue.close();
    redis.disconnect();
    await db.$disconnect();
  });

  it("keeps the claim of an attempt that outlives its lease, through the heartbeat", async () => {
    const versionId = await seedInvoice();
    const slow = slowLlm(LEASE_SECONDS * 2500);
    startWorker(() => slow.llm);
    await enqueue(versionId);
    await slow.started;
    // With its job gone from Redis, only the lease stops the reconcilers from starting a second attempt.
    await flushRedis();
    startWorker(() => slowLlm().llm);

    const { version, runs } = await waitForStatus(versionId, "extracted");
    expect(version.attempts).toBe(1);
    expect(runs.map((r) => r.outcome)).toEqual(["succeeded"]);
  });

  it("resumes a version whose worker was killed mid-extraction, after the lease expires", async () => {
    const versionId = await seedInvoice();
    const stuck = slowLlm(Infinity);
    const first = startWorker(() => stuck.llm);
    await enqueue(versionId);
    await stuck.started;
    await first.kill();
    startWorker(() => slowLlm().llm);

    const { version, values, runs } = await waitForStatus(versionId, "extracted");
    expect(version).toMatchObject({ attempts: 2, leaseUntil: null, error: null });
    expect(values).toHaveLength(5);
    // The killed attempt never finished, and its run row says so.
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, null],
      [2, "succeeded"],
    ]);
  });

  it("finishes a version in flight through a Redis flush, leaving other versions' values, reviews and runs intact", async () => {
    const doneId = await seedInvoice();
    startWorker(() => slowLlm().llm);
    await enqueue(doneId);
    const done = await waitForStatus(doneId, "extracted");
    await db.review.create({ data: { valueId: done.values[0]!.id, action: "approve" } });
    const before = await state(doneId);
    await Promise.all(running.splice(0).map((w) => w.stop()));

    const versionId = await seedInvoice();
    const gated = slowLlm(Infinity);
    startWorker(() => gated.llm);
    await enqueue(versionId);
    await gated.started;
    await flushRedis();
    gated.release();

    const { version, values, runs } = await waitForStatus(versionId, "extracted");
    expect(version.attempts).toBe(1);
    expect(values).toHaveLength(5);
    expect(runs.map((r) => r.outcome)).toEqual(["succeeded"]);
    expect(await state(doneId)).toEqual(before);
    expect(before.values[0]!.reviews).toHaveLength(1);
  });

  it("extracts every queued version whose job a Redis flush lost", async () => {
    const ids = [await seedInvoice(), await seedInvoice(), await seedInvoice()];
    await enqueue(...ids);
    await flushRedis();
    expect(await queue.getJobCounts("waiting", "active")).toEqual({ waiting: 0, active: 0 });

    startWorker(() => slowLlm().llm); // its startup reconcile finds them in Postgres
    for (const id of ids) {
      const { version, values } = await waitForStatus(id, "extracted");
      expect(version.attempts).toBe(1);
      expect(values).toHaveLength(5);
    }
  });

  it("runs a version enqueued 3 times in parallel once, and lets only one of 3 parallel claims through", async () => {
    const versionId = await seedInvoice();
    startWorker(() => slowLlm(300).llm);
    startWorker(() => slowLlm(300).llm);
    await Promise.all([enqueue(versionId), enqueue(versionId), enqueue(versionId)]);
    const { values, runs } = await waitForStatus(versionId, "extracted");
    expect(runs).toHaveLength(1);
    expect(values).toHaveLength(5);

    // Without BullMQ's deduplication, the claim alone decides.
    await Promise.all(running.splice(0).map((w) => w.stop()));
    const otherId = await seedInvoice();
    const deps = { db, getObject: async () => invoicePdf, llm: slowLlm().llm, model: "fake-model", fields, leaseSeconds: 60 };
    const outcomes = await Promise.all([1, 2, 3].map(() => processVersion(deps, otherId)));
    expect(outcomes.sort()).toEqual(["extracted", "not_claimable", "not_claimable"]);
    expect((await state(otherId)).values).toHaveLength(5);
  });

  it("fails a PDF that crashes the worker on every attempt, after 3 attempts", async () => {
    const versionId = await seedInvoice();
    let crashes = 0;
    // Like the compose restart policy: every crash brings up a fresh worker, which crashes on the same PDF.
    const crashingWorker = () =>
      startWorker((self) => async () => {
        crashes++;
        await self.kill();
        crashingWorker();
        return never();
      });
    crashingWorker();
    await enqueue(versionId);

    const { version, runs } = await waitForStatus(versionId, "failed");
    expect(version.error).toMatch(/^too_many_attempts: /);
    expect(version.attempts).toBe(3);
    expect(crashes).toBe(3);
    expect(runs.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("extracts a failed version after a retry", async () => {
    const versionId = await seedInvoice("failed", { attempts: 3, error: "too_many_attempts: 3 attempts did not finish" });
    startWorker(() => slowLlm().llm);
    await sleep(RECONCILE_SECONDS * 3000);
    expect((await state(versionId)).version.status).toBe("failed"); // a failure stays a failure until a user retries

    // What POST /documents/:id/retry does (apps/api/src/retry.ts).
    await db.documentVersion.update({ where: { id: versionId }, data: { status: "queued", error: null, attempts: 0, leaseUntil: null } });
    await enqueue(versionId);

    const { version, values } = await waitForStatus(versionId, "extracted");
    expect(version).toMatchObject({ attempts: 1, error: null });
    expect(values).toHaveLength(5);
  });
});
