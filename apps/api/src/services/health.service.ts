import { VersionStatus, type PrismaClient } from "@lomi/db";
import type { Queue } from "bullmq";

/** Document versions per status, every status present. Doubles as the Postgres health check. */
export async function versionCounts(db: PrismaClient): Promise<Record<string, number>> {
  const rows = await db.documentVersion.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(Object.values(VersionStatus).map((s) => [s, rows.find((r) => r.status === s)?._count._all ?? 0]));
}

/** Extraction jobs waiting and active. Doubles as the Redis health check. */
export const queueCounts = (queue: Queue) => queue.getJobCounts("waiting", "active");
