import type { PrismaClient } from "@lomi/db";
import { Queue, type ConnectionOptions } from "bullmq";

/**
 * The extraction queue with the job options every producer must use (the api sets the same ones).
 * Finished jobs leave Redis because BullMQ silently ignores adding a jobId it still holds, which
 * would block every retry and reconcile of that version. attempts 1: a failure is a visible state.
 */
export const extractionQueue = (connection: ConnectionOptions, name = "extraction") =>
  new Queue(name, { connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 1 } });

/** jobId = versionId: a duplicate of a waiting or active job is ignored, and the claim decides the rest. */
export const enqueueVersions = (queue: Queue, versionIds: string[]) =>
  queue.addBulk(versionIds.map((versionId) => ({ name: "extract", data: { versionId }, opts: { jobId: versionId } })));

/** Enqueues every version Postgres says needs extracting, whatever Redis lost (spec 007). */
export async function reconcile(db: Pick<PrismaClient, "$queryRaw">, enqueue: (versionIds: string[]) => Promise<unknown>) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM document_versions
    WHERE status = 'queued' OR (status = 'extracting' AND lease_until < now())
    ORDER BY created_at`;
  if (rows.length) {
    await enqueue(rows.map((r) => r.id));
    console.log(`reconciler: re-enqueued ${rows.length} version${rows.length === 1 ? "" : "s"}`);
  }
  return rows.length;
}

/** Runs `run` now and then every `seconds`, never two at once. Returns a stop function. */
export function startReconciler(run: () => Promise<unknown>, seconds: number) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      await run();
    } catch (err) {
      console.error("reconciler: run failed", err);
    }
    if (!stopped) timer = setTimeout(tick, seconds * 1000).unref();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
