import { readFileSync } from "node:fs";
import { ExpectedFieldsSchema, ExtractionError, type Llm, type LlmField } from "@lomi/core";
import { createDb, type PrismaClient } from "@lomi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processJob, processVersion } from "../src/extract.js";
import type { ExtractDeps } from "../src/types/extract.js";

// Runs against a dedicated test database (see spec 007): TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test
const url = process.env.TEST_DATABASE_URL;
const fixture = (path: string) => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url));
const fields = ExpectedFieldsSchema.parse(JSON.parse(fixture("expected-fields.json").toString()));
const invoicePdf = new Uint8Array(fixture("documents/invoice-001.pdf"));

const invoiceAnswer: LlmField[] = [
  { key: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", reason: null },
  { key: "issue_date", value: "2025-09-14", evidence: "Issue Date: 2025-09-14", reason: null },
  { key: "due_date", value: "2025-10-14", evidence: "Due Date: 2025-10-14", reason: null },
  { key: "vendor_name", value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
  { key: "total_amount", value: "$5,230.29", evidence: "Total Due:   $5,230.29", reason: null },
];

/** A fake model that answers with `answer`, after running `during` (to interleave other work). */
function fakeLlm(answer = invoiceAnswer, during?: () => Promise<void>): Llm & { calls: number } {
  const llm = Object.assign(
    async () => {
      llm.calls++;
      await during?.();
      return { raw: JSON.stringify({ fake: true }), text: JSON.stringify({ fields: answer }), stopReason: "end_turn", tokensIn: 100, tokensOut: 50 };
    },
    { calls: 0 },
  );
  return llm;
}

describe.skipIf(!url)("processVersion against Postgres", () => {
  let db: PrismaClient;
  const documentIds: string[] = [];
  const deps = (over: Partial<ExtractDeps> = {}): ExtractDeps => ({
    db,
    getObject: async () => invoicePdf,
    llm: fakeLlm(),
    model: "fake-model",
    fields,
    leaseSeconds: 60,
    ...over,
  });

  async function seedInvoice() {
    const doc = await db.document.create({ data: { type: "invoice", title: "worker test invoice" } });
    const version = await db.documentVersion.create({
      data: { documentId: doc.id, versionNo: 1, storageKey: "pdfs/test.pdf", sha256: "test", sizeBytes: invoicePdf.length, mimeType: "application/pdf" },
    });
    await db.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    documentIds.push(doc.id);
    return { documentId: doc.id, versionId: version.id };
  }

  /** What the api's createVersion does for a new version of an existing document: the previous one keeps its status. */
  async function uploadNextVersion(documentId: string) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId} FOR UPDATE`;
      const next = await tx.documentVersion.create({
        data: { documentId, versionNo: 2, storageKey: "pdfs/test2.pdf", sha256: "test2", sizeBytes: 1, mimeType: "application/pdf" },
      });
      await tx.document.update({ where: { id: documentId }, data: { currentVersionId: next.id } });
      return next.id;
    });
  }

  /** What the api's deleteDocument does (spec 011): under the document lock, mark it deleted and stop its in-flight versions. */
  async function deleteDocument(documentId: string) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId} FOR UPDATE`;
      await tx.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
      await tx.documentVersion.updateMany({ where: { documentId, status: { in: ["queued", "extracting"] } }, data: { status: "superseded", leaseUntil: null } });
    });
  }

  const state = async (versionId: string) => ({
    version: await db.documentVersion.findUniqueOrThrow({ where: { id: versionId } }),
    values: await db.extractedValue.findMany({ where: { versionId }, orderBy: { fieldKey: "asc" } }),
    runs: await db.extractionRun.findMany({ where: { versionId }, orderBy: { startedAt: "asc" } }),
  });

  beforeAll(() => {
    db = createDb(url!);
  });

  afterAll(async () => {
    const inDocs = { version: { documentId: { in: documentIds } } };
    await db.review.deleteMany({ where: { value: inDocs } });
    await db.extractedValue.deleteMany({ where: inDocs });
    await db.extractionRun.deleteMany({ where: inDocs });
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    await db.$disconnect();
  });

  it("extracts one value per expected field, with evidence at its offsets, and records the run", async () => {
    const { versionId } = await seedInvoice();
    expect(await processVersion(deps(), versionId)).toBe("extracted");

    const { version, values, runs } = await state(versionId);
    expect(version).toMatchObject({ status: "extracted", attempts: 1, leaseUntil: null, error: null });
    expect(version.parsedText).toContain("Total Due: $5,230.29");
    expect(values.map((v) => v.fieldKey).sort()).toEqual(fields.invoice!.map((f) => f.field).sort());
    for (const v of values) {
      expect(v).toMatchObject({ reviewStatus: "pending", gapReason: null });
      expect(version.parsedText!.slice(v.evidenceStart!, v.evidenceEnd!)).toBe(v.evidence);
    }
    expect(values.find((v) => v.fieldKey === "total_amount")!.evidence).toBe("Total Due: $5,230.29");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attempt: 1, model: "fake-model", outcome: "succeeded", tokensIn: 100, tokensOut: 50, error: null });
    expect(runs[0]!.prompt).toContain("<document>\nMERIDIAN OFFICE SUPPLIES LLC");
    expect(runs[0]!.rawResponse).toBe('{"fake":true}');
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  it("does nothing when the same job runs again", async () => {
    const { versionId } = await seedInvoice();
    expect(await processVersion(deps(), versionId)).toBe("extracted");
    const llm = fakeLlm();
    expect(await processVersion(deps({ llm }), versionId)).toBe("not_claimable");

    const { values, runs } = await state(versionId);
    expect(llm.calls).toBe(0);
    expect(values).toHaveLength(5);
    expect(runs).toHaveLength(1);
  });

  it("does not duplicate values when a second attempt reclaims an expired lease and commits first", async () => {
    const { versionId } = await seedInvoice();
    // While attempt 1 waits on the model, its lease expires and attempt 2 runs to completion.
    const slow = fakeLlm(invoiceAnswer, async () => {
      await db.$executeRaw`UPDATE document_versions SET lease_until = now() - interval '1 second' WHERE id = ${versionId}::uuid`;
      expect(await processVersion(deps(), versionId)).toBe("extracted");
    });
    expect(await processVersion(deps({ llm: slow }), versionId)).toBe("extracted");

    const { version, values, runs } = await state(versionId);
    expect(version).toMatchObject({ status: "extracted", attempts: 2 });
    expect(values).toHaveLength(5);
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([
      [1, "succeeded"],
      [2, "succeeded"],
    ]);
  });

  it("carries each review once when a reclaimed attempt commits a new version first", async () => {
    const { documentId, versionId: v1 } = await seedInvoice();
    expect(await processVersion(deps(), v1)).toBe("extracted");
    for (const { id } of await db.extractedValue.findMany({ where: { versionId: v1 } })) {
      await db.review.create({ data: { valueId: id, action: "approve" } });
    }
    const v2 = await uploadNextVersion(documentId);
    const slow = fakeLlm(invoiceAnswer, async () => {
      await db.$executeRaw`UPDATE document_versions SET lease_until = now() - interval '1 second' WHERE id = ${v2}::uuid`;
      expect(await processVersion(deps(), v2)).toBe("extracted");
    });
    expect(await processVersion(deps({ llm: slow }), v2)).toBe("extracted");

    const values = await db.extractedValue.findMany({ where: { versionId: v2 }, include: { reviews: true } });
    expect(values).toHaveLength(5);
    for (const v of values) {
      expect(v.reviewStatus).toBe("carried_over");
      expect(v.previousValueId).not.toBeNull();
      expect(v.reviews).toHaveLength(1);
    }
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: v1 } })).status).toBe("extracted");
  });

  it("records an LLM failure on the version and the run, without throwing", async () => {
    const { versionId } = await seedInvoice();
    const llm: Llm = async () => {
      throw new ExtractionError("llm_request_failed", "529 overloaded");
    };
    expect(await processVersion(deps({ llm }), versionId)).toBe("failed");

    const { version, values, runs } = await state(versionId);
    expect(version).toMatchObject({ status: "failed", error: "llm_request_failed: 529 overloaded", leaseUntil: null });
    expect(values).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "failed", error: "llm_request_failed: 529 overloaded", rawResponse: null });
    expect(runs[0]!.prompt).toContain("<document>");
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  it("writes no values when a new version is uploaded while the model runs", async () => {
    const { documentId, versionId } = await seedInvoice();
    const llm = fakeLlm(invoiceAnswer, async () => void (await uploadNextVersion(documentId)));
    expect(await processVersion(deps({ llm }), versionId)).toBe("superseded");

    const { version, values, runs } = await state(versionId);
    expect(version).toMatchObject({ status: "superseded", leaseUntil: null });
    expect(values).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "superseded" });
    expect(runs[0]!.rawResponse).toBe('{"fake":true}');
  });

  it("skips the model when a new version is uploaded before the call", async () => {
    const { documentId, versionId } = await seedInvoice();
    const llm = fakeLlm();
    const getObject = async () => (await uploadNextVersion(documentId), invoicePdf);
    expect(await processVersion(deps({ llm, getObject }), versionId)).toBe("superseded");

    const { version, values, runs } = await state(versionId);
    expect(llm.calls).toBe(0);
    expect(version.status).toBe("superseded");
    expect(values).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "superseded", prompt: null });
  });

  it("writes no values when the document is deleted while the model runs", async () => {
    const { documentId, versionId } = await seedInvoice();
    const llm = fakeLlm(invoiceAnswer, () => deleteDocument(documentId));
    expect(await processVersion(deps({ llm }), versionId)).toBe("superseded");

    const { version, values, runs } = await state(versionId);
    expect(version).toMatchObject({ status: "superseded", leaseUntil: null });
    expect(values).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "superseded" });
  });

  it("skips the model when the document is deleted before the call, and never claims it again", async () => {
    const { documentId, versionId } = await seedInvoice();
    const llm = fakeLlm();
    const getObject = async () => (await deleteDocument(documentId), invoicePdf);
    expect(await processVersion(deps({ llm, getObject }), versionId)).toBe("superseded");

    const { version, values, runs } = await state(versionId);
    expect(llm.calls).toBe(0);
    expect(version.status).toBe("superseded");
    expect(values).toEqual([]);
    expect(runs[0]).toMatchObject({ outcome: "superseded", prompt: null });
    expect(await processVersion(deps({ llm }), versionId)).toBe("not_claimable");
  });
});

describe("processJob", () => {
  it("skips a job whose data has no uuid versionId, before touching the database or the model", async () => {
    const untouched = new Proxy({} as PrismaClient, {
      get: () => {
        throw new Error("database touched");
      },
    });
    const llm = fakeLlm();
    const deps: ExtractDeps = { db: untouched, getObject: async () => invoicePdf, llm, model: "fake-model", fields, leaseSeconds: 60 };
    for (const data of [null, {}, { versionId: 42 }, { versionId: "not-a-uuid" }]) {
      expect(await processJob(deps, "job-1", data), JSON.stringify(data)).toBe("skipped");
    }
    expect(llm.calls).toBe(0);
  });
});
