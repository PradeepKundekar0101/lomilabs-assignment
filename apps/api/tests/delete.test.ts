import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { ExpectedFieldsSchema } from "@lomi/core";
import { createDb, type PrismaClient, type VersionStatus } from "@lomi/db";
import { DocumentListSchema } from "@lomi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { retryDocument } from "../src/services/retry.service.js";
import { createVersion } from "../src/services/versions.service.js";

// Runs against a dedicated test database (see spec 007): TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test
const dbUrl = process.env.TEST_DATABASE_URL;
const fields = ExpectedFieldsSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/expected-fields.json", import.meta.url), "utf8")));
const pdf = readFileSync(new URL("../../../fixtures/documents/invoice-001.pdf", import.meta.url));

describe.skipIf(!dbUrl)("DELETE /documents/:id against Postgres (spec 011)", () => {
  let db: PrismaClient;
  let server: Server;
  let base: string;
  const documentIds: string[] = [];

  beforeAll(async () => {
    db = createDb(dbUrl!);
    const unused = async () => {
      throw new Error("not used here");
    };
    const enqueue = async () => {};
    server = createApp({
      checks: { db: unused, redis: unused },
      db,
      fields,
      createVersion: (target, file) => createVersion({ db, putObject: async () => {}, enqueue }, target, file),
      retry: (documentId) => retryDocument({ db, enqueue }, documentId),
    }).listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    const ofDocs = { version: { documentId: { in: documentIds } } };
    await db.review.deleteMany({ where: { value: ofDocs } });
    await db.extractedValue.deleteMany({ where: ofDocs });
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    server.close();
    await db.$disconnect();
  });

  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const remove = (id: string) => call(`/documents/${id}`, { method: "DELETE" });

  /** An invoice whose current version 1 has `status`, with one approved value. */
  async function seedInvoice(status: VersionStatus) {
    const doc = await db.document.create({ data: { type: "invoice", title: "delete test" } });
    documentIds.push(doc.id);
    const version = await db.documentVersion.create({
      data: { documentId: doc.id, versionNo: 1, status, storageKey: "pdfs/test.pdf", sha256: "test", sizeBytes: 1, mimeType: "application/pdf", parsedText: "INV-1" },
    });
    await db.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    const value = await db.extractedValue.create({
      data: { versionId: version.id, fieldKey: "invoice_number", value: "INV-1", evidence: "INV-1", reviewStatus: "approved" },
    });
    await db.review.create({ data: { valueId: value.id, action: "approve" } });
    return { documentId: doc.id, versionId: version.id, valueId: value.id };
  }

  it("hides the document everywhere and keeps its history", async () => {
    const { documentId, versionId, valueId } = await seedInvoice("extracted");

    const res = await remove(documentId);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const list = DocumentListSchema.parse(await (await call("/documents")).json());
    expect(list.map((d) => d.id)).not.toContain(documentId);
    for (const path of [`/documents/${documentId}`, `/documents/${documentId}/versions/1`, `/documents/${documentId}/progress`]) {
      expect((await call(path)).status, path).toBe(404);
    }

    // Nothing can act on it any more.
    expect((await remove(documentId)).status).toBe(404);
    const form = new FormData();
    form.set("file", new File([pdf], "v2.pdf", { type: "application/pdf" }));
    expect((await call(`/documents/${documentId}/versions`, { method: "POST", body: form })).status).toBe(404);
    expect((await call(`/documents/${documentId}/retry`, { method: "POST" })).status).toBe(404);
    const review = await call(`/values/${valueId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "correct", correctedValue: "INV-2" }),
    });
    expect(review.status).toBe(404);

    // Soft delete: the rows are all still there, and no review was added.
    expect((await db.document.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).toBeInstanceOf(Date);
    expect(await db.documentVersion.count({ where: { documentId } })).toBe(1);
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: versionId } })).status).toBe("extracted");
    expect(await db.review.count({ where: { valueId } })).toBe(1);
  });

  it("stops the extraction of a queued or extracting version", async () => {
    const queued = await seedInvoice("queued");
    const extracting = await seedInvoice("extracting");
    await db.documentVersion.update({ where: { id: extracting.versionId }, data: { leaseUntil: new Date(Date.now() + 60_000) } });

    expect((await remove(queued.documentId)).status).toBe(204);
    expect((await remove(extracting.documentId)).status).toBe(204);
    for (const { versionId } of [queued, extracting]) {
      expect(await db.documentVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: "superseded", leaseUntil: null });
    }
  });

  it("answers 404 for an unknown document", async () => {
    expect((await remove("no-such-document")).status).toBe(404);
  });
});
