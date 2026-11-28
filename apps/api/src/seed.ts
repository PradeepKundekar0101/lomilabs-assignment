import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInfra } from "./infra.js";
import { loadEnv, SeedEnvSchema } from "./schemas/env.schema.js";
import { ManifestSchema } from "./schemas/manifest.schema.js";
import { seed } from "./services/seed.service.js";

// The migrate-seed container's entry point: seeds version 1 of each fixture document (spec 006).
const env = loadEnv(SeedEnvSchema);
const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(env.FIXTURES_DIR, "documents.json"), "utf8")));
const { db, queue, queueConnection, versionDeps } = createInfra(env);
// The fail-fast queue rejects jobs until Redis is connected; wait briefly so the seed's jobs are not
// dropped. If Redis stays away, createVersion logs each failed enqueue and the rows stay queued.
if (queueConnection.status !== "ready") {
  await once(queueConnection, "ready", { signal: AbortSignal.timeout(10_000) }).catch(() => console.error("seed: redis not ready"));
}
try {
  await seed({ ...versionDeps, db }, manifest, env.FIXTURES_DIR);
} finally {
  await queue.close();
  // The queue does not close a connection it was handed.
  queueConnection.disconnect();
  await db.$disconnect();
}
