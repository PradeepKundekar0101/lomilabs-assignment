import { readFileSync } from "node:fs";
import { ExpectedFieldsSchema } from "@lomi/core";
import { createApp } from "./app.js";
import { createInfra } from "./infra.js";
import { ApiEnvSchema, loadEnv } from "./schemas/env.schema.js";
import { queueCounts, versionCounts } from "./services/health.service.js";
import { retryDocument } from "./services/retry.service.js";
import { createVersion } from "./services/versions.service.js";

const env = loadEnv(ApiEnvSchema);
// The queue's connection has no offline queue, so a count while Redis is down fails at once instead of hanging the health check.
const { db, queue, queueConnection, versionDeps } = createInfra(env);
const fields = ExpectedFieldsSchema.parse(JSON.parse(readFileSync(env.EXPECTED_FIELDS_PATH, "utf8")));

const server = createApp({
  checks: { db: () => versionCounts(db), redis: () => queueCounts(queue) },
  db,
  fields,
  createVersion: (target, file) => createVersion(versionDeps, target, file),
  retry: (documentId) => retryDocument({ db, enqueue: versionDeps.enqueue }, documentId),
}).listen(env.PORT, () => console.log(`api listening on :${env.PORT}`));

process.on("SIGTERM", () => {
  server.close();
  void db.$disconnect();
  // The queue does not close a connection it was handed.
  void queue.close().then(() => queueConnection.disconnect());
});
