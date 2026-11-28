import type { ExpectedFields } from "@lomi/core";
import type { PrismaClient } from "@lomi/db";
import type { CreateVersionResult, RetryResult, VersionTarget } from "./versions.js";

/** Each check returns counts, so a successful count is also the service's health check. */
export interface HealthChecks {
  /** Document versions per status. */
  db: () => Promise<Record<string, number>>;
  /** Extraction jobs waiting and active. */
  redis: () => Promise<Record<string, number>>;
}

/** Everything the HTTP app needs; `main.ts` wires the real ones, tests pass fakes. */
export interface AppDeps {
  checks: HealthChecks;
  db: PrismaClient;
  /** Expected fields per document type: their order is the values' order within a review group. */
  fields: ExpectedFields;
  createVersion: (target: VersionTarget, file: File) => Promise<CreateVersionResult>;
  retry: (documentId: string) => Promise<RetryResult>;
  /** The review UI's origin when it is not served same-origin; its requests get CORS headers. */
  webOrigin?: string;
}
