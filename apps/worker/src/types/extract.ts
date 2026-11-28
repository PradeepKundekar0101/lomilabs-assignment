import type { ExpectedFields, Llm } from "@lomi/core";
import type { PrismaClient } from "@lomi/db";
import type { z } from "zod";
import type { ExtractJobSchema } from "../schemas/job.schema.js";

export interface ExtractDeps {
  db: PrismaClient;
  getObject: (key: string) => Promise<Uint8Array>;
  llm: Llm;
  model: string;
  fields: ExpectedFields;
  /** How long a claim lasts without a heartbeat; the heartbeat renews it every third of that. */
  leaseSeconds: number;
}

export type ExtractOutcome = "not_claimable" | "superseded" | "extracted" | "failed";

/** The data of an `extract` job on the `extraction` queue. */
export type ExtractJob = z.infer<typeof ExtractJobSchema>;

/** The row the claim's UPDATE ... RETURNING gives back. */
export interface ClaimedVersion {
  id: string;
  document_id: string;
  version_no: number;
  storage_key: string;
  attempts: number;
}
