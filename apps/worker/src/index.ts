import type { JobStore } from "@lomi/db";
import type { Job } from "@lomi/shared";

export type Handler = (job: Job) => void | Promise<void>;

export async function processNext(store: JobStore, handlers: Record<string, Handler>): Promise<Job | undefined> {
  const job = store.nextQueued();
  if (!job) return undefined;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`No handler for ${job.type}`);
    await handler(job);
    store.setStatus(job.id, "done");
  } catch {
    store.setStatus(job.id, "failed");
  }
  return job;
}
