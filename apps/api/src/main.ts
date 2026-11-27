import { readFileSync } from "node:fs";
import { ExpectedFieldsSchema } from "@lomi/core";
import { VersionStatus } from "@lomi/db";
import { createApp } from "./app.js";
import { createVersion } from "./create-version.js";
import { retryDocument } from "./retry.js";
import { createServices, requireEnv } from "./services.js";

const port = Number(process.env.PORT ?? 3000);
// The queue's connection has no offline queue, so a count while Redis is down fails at once instead of hanging the health check.
const { db, queue, queueConnection, versionDeps } = createServices();
const fields = ExpectedFieldsSchema.parse(JSON.parse(readFileSync(requireEnv("EXPECTED_FIELDS_PATH"), "utf8")));

const server = createApp({
  checks: {
    db: async () => {
      const rows = await db.documentVersion.groupBy({ by: ["status"], _count: { _all: true } });
      return Object.fromEntries(Object.values(VersionStatus).map((s) => [s, rows.find((r) => r.status === s)?._count._all ?? 0]));
    },
    redis: () => queue.getJobCounts("waiting", "active"),
  },
  db,
  fields,
  createVersion: (target, file) => createVersion(versionDeps, target, file),
  retry: (documentId) => retryDocument({ db, enqueue: versionDeps.enqueue }, documentId),
}).listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void db.$disconnect();
  // The queue does not close a connection it was handed.
  void queue.close().then(() => queueConnection.disconnect());
});
