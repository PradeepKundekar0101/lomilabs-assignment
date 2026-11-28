import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, type PrismaClient } from "@lomi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed } from "../src/services/seed.service.js";
import type { ManifestDocument } from "../src/types/seed.js";

// Runs against a dedicated test database (see spec 007): TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test
const url = process.env.TEST_DATABASE_URL;
const fixturesDir = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(`${fixturesDir}${file}`)).digest("hex");

describe.skipIf(!url)("seed against Postgres", () => {
  let db: PrismaClient;
  // The real manifest under prefixed ids, so the test neither collides with nor deletes the stack's seeded documents.
  const prefix = `test-${randomUUID()}-`;
  const manifest: ManifestDocument[] = JSON.parse(readFileSync(`${fixturesDir}documents.json`, "utf8")).map(
    (doc: ManifestDocument) => ({ ...doc, id: prefix + doc.id }),
  );
  const ids = manifest.map((doc) => doc.id);

  beforeAll(() => {
    db = createDb(url!);
  });

  afterAll(async () => {
    await db.document.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: ids } } });
    await db.document.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("seeds version 1 of each manifest document once, however often it runs", async () => {
    const stored: string[] = [];
    const enqueued: string[] = [];
    const logs: string[] = [];
    const deps = {
      db,
      putObject: async (key: string) => void stored.push(key),
      enqueue: async (versionId: string) => void enqueued.push(versionId),
    };

    await seed(deps, manifest, fixturesDir, (line) => logs.push(line));
    await seed(deps, manifest, fixturesDir, (line) => logs.push(line));

    const docs = await db.document.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true, title: true, currentVersionId: true, versions: { select: { id: true, versionNo: true, status: true, sha256: true } } },
      orderBy: { id: "asc" },
    });
    expect(docs).toHaveLength(manifest.length);
    for (const doc of docs) {
      const source = manifest.find((m) => m.id === doc.id)!;
      expect(doc).toMatchObject({ type: source.type, title: source.title });
      expect(doc.versions).toEqual([expect.objectContaining({ versionNo: 1, status: "queued", id: doc.currentVersionId })]);
    }
    const invoice = docs.find((doc) => doc.id === `${prefix}doc-invoice-001`)!;
    expect(invoice.versions[0]!.sha256).toBe(sha256("documents/invoice-001.pdf"));
    expect(invoice.versions[0]!.sha256).not.toBe(sha256("documents/invoice-001.v2.pdf"));

    // Each document is stored and enqueued once, by the first run only.
    expect([...enqueued].sort()).toEqual(docs.map((doc) => doc.currentVersionId).sort());
    expect(stored).toHaveLength(manifest.length);
    expect(logs.filter((l) => l.includes(" seeded, "))).toHaveLength(manifest.length);
    expect(logs.filter((l) => l.endsWith(" skipped, already exists"))).toHaveLength(manifest.length);
  });
});
