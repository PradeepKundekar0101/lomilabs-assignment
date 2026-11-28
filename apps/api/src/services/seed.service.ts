import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ManifestDocument, SeedDeps } from "../types/seed.js";
import { createVersion } from "./versions.service.js";

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
