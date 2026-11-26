import type { Job, JobStatus } from "@lomi/shared";

// shortcut: in-memory only, swap for a real database client when persistence is needed.
export class JobStore {
  private jobs = new Map<string, Job>();

  save(job: Job): Job {
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  nextQueued(): Job | undefined {
    for (const job of this.jobs.values()) if (job.status === "queued") return job;
    return undefined;
  }

  setStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job ${id} not found`);
    job.status = status;
  }
}

export * from "./generated/prisma/client.js";
export { createDb } from "./client.js";
