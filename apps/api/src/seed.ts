import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DocumentType, PrismaClient } from "@lomi/db";
import { createVersion, type CreateVersionDeps } from "./create-version.js";
import { createServices, requireEnv } from "./services.js";

/** An entry of fixtures/documents.json. */
export interface ManifestDocument {
  id: string;
  type: DocumentType;
  title: string;
  versions: { version: number; file: string }[];
}

export type SeedDeps = CreateVersionDeps & { db: Pick<PrismaClient, "$transaction" | "document"> };

/**
 * Seeds version 1 of each manifest document through the upload path (`createVersion`), under the
 * manifest's id. Documents that already exist are skipped, so re-running adds nothing.
 */
export async function seed(deps: SeedDeps, manifest: ManifestDocument[], fixturesDir: string, log = console.log) {
  for (const doc of manifest) {
    if (await deps.db.document.findUnique({ where: { id: doc.id }, select: { id: true } })) {
      log(`seed: ${doc.id} skipped, already exists`);
      continue;
    }
    // Later versions exist to exercise re-extraction by upload, so they are never seeded.
    const v1 = doc.versions.find((v) => v.version === 1);
    if (!v1) throw new Error(`seed: ${doc.id} has no version 1 in the manifest`);
    const file = new File([await readFile(join(fixturesDir, v1.file))], basename(v1.file), { type: "application/pdf" });
    const { versionId, status } = await createVersion(deps, { id: doc.id, type: doc.type, title: doc.title }, file);
    log(`seed: ${doc.id} seeded, version ${versionId} ${status}`);
  }
}

if (import.meta.main) {
  const fixturesDir = requireEnv("FIXTURES_DIR");
  const { db, queue, queueConnection, versionDeps } = createServices();
  // The fail-fast queue rejects jobs until Redis is connected; wait briefly so the seed's jobs are not
  // dropped. If Redis stays away, createVersion logs each failed enqueue and the rows stay queued.
  if (queueConnection.status !== "ready") {
    await once(queueConnection, "ready", { signal: AbortSignal.timeout(10_000) }).catch(() => console.error("seed: redis not ready"));
  }
  const manifest: ManifestDocument[] = JSON.parse(await readFile(join(fixturesDir, "documents.json"), "utf8"));
  try {
    await seed({ ...versionDeps, db }, manifest, fixturesDir);
  } finally {
    await queue.close();
    // The queue does not close a connection it was handed.
    queueConnection.disconnect();
    await db.$disconnect();
  }
}
