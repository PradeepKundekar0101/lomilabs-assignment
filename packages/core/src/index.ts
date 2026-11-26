import { createId, type Job } from "@lomi/shared";

export function createJob(type: string, payload: unknown): Job {
  if (!type.trim()) throw new Error("Job type is required");
  return { id: createId("job"), type, payload, status: "queued", createdAt: new Date() };
}
