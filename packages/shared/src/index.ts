import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "done" | "failed";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  createdAt: Date;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
