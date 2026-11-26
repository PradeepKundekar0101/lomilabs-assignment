import { createJob } from "@lomi/core";
import { JobStore } from "@lomi/db";
import type { Job } from "@lomi/shared";

export function enqueue(store: JobStore, body: { type?: unknown; payload?: unknown }): Job {
  if (typeof body.type !== "string") throw new Error("type must be a string");
  return store.save(createJob(body.type, body.payload));
}
