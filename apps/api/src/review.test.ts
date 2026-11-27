import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { ExpectedFieldsSchema } from "@lomi/core";
import { createDb, type PrismaClient, type ReviewStatus, type VersionStatus } from "@lomi/db";
import { DocumentListSchema, DocumentViewSchema, ProgressSchema } from "@lomi/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createVersion } from "./create-version.js";

// Runs against a dedicated test database (see spec 007): TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test
const dbUrl = process.env.TEST_DATABASE_URL;
const fields = ExpectedFieldsSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/expected-fields.json", import.meta.url), "utf8")));

interface SeedValue {
  fieldKey: string;
  value: string | null;
  reviewStatus?: ReviewStatus;
}

describe.skipIf(!dbUrl)("review API against Postgres", () => {
  let db: PrismaClient;
  let server: Server;
  let base: string;
  const documentIds: string[] = [];

  beforeAll(async () => {
    db = createDb(dbUrl!);
    const unused = async () => {
      throw new Error("not used here");
    };
    server = createApp({ checks: { db: unused, redis: unused }, db, fields, createVersion: unused, retry: unused }).listen(0);
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

  async function call(path: string, body?: unknown) {
    const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() };
  }
  const review = (valueId: string, body: unknown) => call(`/values/${valueId}/review`, body);

  async function addVersion(documentId: string, versionNo: number, status: VersionStatus, values: (SeedValue & { previousValueId?: string })[]) {
    const version = await db.documentVersion.create({
      data: { documentId, versionNo, status, storageKey: "pdfs/test.pdf", sha256: "test", sizeBytes: 1, mimeType: "application/pdf", parsedText: `text of v${versionNo}` },
    });
    await db.document.update({ where: { id: documentId }, data: { currentVersionId: version.id } });
    const ids: Record<string, string> = {};
    for (const v of values) {
      const gapReason = v.value === null ? "not in the document" : null;
      ids[v.fieldKey] = (await db.extractedValue.create({ data: { versionId: version.id, gapReason, ...v } })).id;
    }
    return { versionId: version.id, ids };
  }

  /** An invoice whose version 1 is extracted and current, with the given values. */
  async function seedInvoice(values: SeedValue[]) {
    const doc = await db.document.create({ data: { id: `test-${randomUUID()}`, type: "invoice", title: "review test" } });
    documentIds.push(doc.id);
    return { documentId: doc.id, ...(await addVersion(doc.id, 1, "extracted", values)) };
  }

  const reviewRows = (valueId: string) => db.review.findMany({ where: { valueId }, orderBy: { createdAt: "asc" } });
  const stored = (valueId: string) => db.extractedValue.findUniqueOrThrow({ where: { id: valueId } });

  it("approves a value: status approved, 1 review row", async () => {
    const { ids } = await seedInvoice([{ fieldKey: "invoice_number", value: "INV-1" }]);
    const r = await review(ids.invoice_number!, { action: "approve", note: "matches the PDF" });
    expect(r).toMatchObject({
      status: 200,
      body: {
        id: ids.invoice_number,
        fieldKey: "invoice_number",
        value: "INV-1",
        reviewStatus: "approved",
        effectiveValue: "INV-1",
        latestReview: { action: "approve", correctedValue: null, note: "matches the PDF" },
        previous: null,
      },
    });
    expect((await stored(ids.invoice_number!)).reviewStatus).toBe("approved");
    expect(await reviewRows(ids.invoice_number!)).toHaveLength(1);
  });

  it("corrects a value beside it: status corrected, value unchanged, effectiveValue is the trimmed correction", async () => {
    const { ids } = await seedInvoice([{ fieldKey: "total_amount", value: "$5,000.00" }]);
    const r = await review(ids.total_amount!, { action: "correct", correctedValue: "  $5,230.29 " });
    expect(r).toMatchObject({
      status: 200,
      body: { value: "$5,000.00", reviewStatus: "corrected", effectiveValue: "$5,230.29", latestReview: { action: "correct", correctedValue: "$5,230.29", note: null } },
    });
    expect(await stored(ids.total_amount!)).toMatchObject({ value: "$5,000.00", reviewStatus: "corrected" });
  });

  it("returns 404 for an unknown or malformed value id", async () => {
    expect((await review(randomUUID(), { action: "approve" })).status).toBe(404);
    expect((await review("not-a-uuid", { action: "approve" })).status).toBe(404);
  });

  it("refuses a value of a version that is no longer current with 409 stale_version", async () => {
    const { documentId, versionId, ids } = await seedInvoice([{ fieldKey: "invoice_number", value: "INV-1" }]);
    await db.documentVersion.update({ where: { id: versionId }, data: { status: "superseded" } });
    await addVersion(documentId, 2, "queued", []);
    expect(await review(ids.invoice_number!, { action: "approve" })).toEqual({ status: 409, body: { error: "stale_version", currentVersionNo: 2 } });
    expect(await reviewRows(ids.invoice_number!)).toHaveLength(0);
    expect((await stored(ids.invoice_number!)).reviewStatus).toBe("pending");
  });

  it("keeps every review when one is approved then corrected, and the newest wins", async () => {
    const { ids } = await seedInvoice([{ fieldKey: "vendor_name", value: "MERIDIAN" }]);
    await review(ids.vendor_name!, { action: "approve" });
    const r = await review(ids.vendor_name!, { action: "correct", correctedValue: "MERIDIAN OFFICE SUPPLIES LLC" });
    expect(r.body).toMatchObject({ reviewStatus: "corrected", effectiveValue: "MERIDIAN OFFICE SUPPLIES LLC" });
    expect((await reviewRows(ids.vendor_name!)).map((row) => row.action)).toEqual(["approve", "correct"]);
    // And back: a newer approve wins over the correction.
    expect((await review(ids.vendor_name!, { action: "approve" })).body).toMatchObject({ reviewStatus: "approved", effectiveValue: "MERIDIAN" });
    expect(await reviewRows(ids.vendor_name!)).toHaveLength(3);
  });

  it("writes one review row for the same approve sent twice, also when sent at the same moment", async () => {
    const { ids } = await seedInvoice([
      { fieldKey: "invoice_number", value: "INV-1" },
      { fieldKey: "due_date", value: "2025-10-14" },
    ]);
    const first = await review(ids.invoice_number!, { action: "approve", note: "ok" });
    const second = await review(ids.invoice_number!, { action: "approve", note: "ok" });
    expect(second).toEqual(first);
    expect(await reviewRows(ids.invoice_number!)).toHaveLength(1);
    // A different note is a new review.
    await review(ids.invoice_number!, { action: "approve", note: "checked twice" });
    expect(await reviewRows(ids.invoice_number!)).toHaveLength(2);

    const both = await Promise.all([review(ids.due_date!, { action: "approve" }), review(ids.due_date!, { action: "approve" })]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await reviewRows(ids.due_date!)).toHaveLength(1);
  });

  it("corrects a gap to supply the value, or approves it as genuinely absent", async () => {
    const { ids } = await seedInvoice([
      { fieldKey: "due_date", value: null },
      { fieldKey: "issue_date", value: null },
    ]);
    expect((await review(ids.due_date!, { action: "correct", correctedValue: "2025-10-14" })).body).toMatchObject({
      value: null,
      gapReason: "not in the document",
      reviewStatus: "corrected",
      effectiveValue: "2025-10-14",
    });
    expect((await review(ids.issue_date!, { action: "approve" })).body).toMatchObject({ value: null, reviewStatus: "approved", effectiveValue: null });
  });

  it("overrides a carried-over value with a new review, even one equal to the carried review", async () => {
    const { ids } = await seedInvoice([{ fieldKey: "due_date", value: "2025-10-14", reviewStatus: "carried_over" }]);
    await db.review.create({ data: { valueId: ids.due_date!, action: "approve" } });
    expect((await review(ids.due_date!, { action: "approve" })).body).toMatchObject({ reviewStatus: "approved" });
    expect(await reviewRows(ids.due_date!)).toHaveLength(2);
  });

  /**
   * Version 1 (superseded, reviewed in its time) and version 2 (current), where version 2 has a pending value,
   * a pending gap, a carried-over value, and two values approved and corrected through the API.
   */
  async function seedTwoVersions() {
    const v1 = await seedInvoice([
      { fieldKey: "invoice_number", value: "INV-1" },
      { fieldKey: "issue_date", value: "2025-09-14" },
      { fieldKey: "due_date", value: "2025-10-14", reviewStatus: "approved" },
      { fieldKey: "vendor_name", value: "MERIDIAN" },
      { fieldKey: "total_amount", value: "$5,000.00", reviewStatus: "corrected" },
    ]);
    const dueApproval = await db.review.create({ data: { valueId: v1.ids.due_date!, action: "approve", note: "v1 check" } });
    await db.review.create({ data: { valueId: v1.ids.total_amount!, action: "correct", correctedValue: "$5,230.29" } });
    await db.documentVersion.update({ where: { id: v1.versionId }, data: { status: "superseded" } });

    const prev = (fieldKey: string) => ({ previousValueId: v1.ids[fieldKey]! });
    const v2 = await addVersion(v1.documentId, 2, "extracted", [
      { fieldKey: "invoice_number", value: null, ...prev("invoice_number") },
      { fieldKey: "issue_date", value: "2025-09-14", ...prev("issue_date") },
      { fieldKey: "due_date", value: "2025-10-14", reviewStatus: "carried_over", ...prev("due_date") },
      { fieldKey: "vendor_name", value: "MERIDIAN", ...prev("vendor_name") },
      { fieldKey: "total_amount", value: "$5,000.00", ...prev("total_amount") },
    ]);
    await db.review.create({ data: { valueId: v2.ids.due_date!, action: "approve", note: "v1 check", carriedFromReviewId: dueApproval.id } });
    await review(v2.ids.vendor_name!, { action: "approve" });
    await review(v2.ids.total_amount!, { action: "correct", correctedValue: "$5,230.29" });
    return { documentId: v1.documentId, v1: v1.ids, v2: v2.ids };
  }

  it("returns the current version's values in review order, each with its previous version's value", async () => {
    const { documentId, v1, v2 } = await seedTwoVersions();
    const { status, body } = await call(`/documents/${documentId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: documentId, currentVersion: { versionNo: 2, status: "extracted" }, version: { versionNo: 2, parsedText: "text of v2" } });
    expect(body.currentVersion).not.toHaveProperty("parsedText");
    DocumentViewSchema.parse(body);
    // Pending first (the gap last among them), then corrected, approved, carried over.
    expect(body.values.map((v: { fieldKey: string }) => v.fieldKey)).toEqual(["issue_date", "invoice_number", "total_amount", "vendor_name", "due_date"]);

    const byKey = Object.fromEntries(body.values.map((v: { fieldKey: string }) => [v.fieldKey, v]));
    expect(Object.keys(byKey.total_amount).sort()).toEqual(
      ["id", "fieldKey", "value", "evidence", "evidenceStart", "evidenceEnd", "gapReason", "reviewStatus", "effectiveValue", "latestReview", "previous"].sort(),
    );
    expect(byKey.total_amount).toMatchObject({
      id: v2.total_amount,
      value: "$5,000.00",
      effectiveValue: "$5,230.29",
      previous: { versionNo: 1, value: "$5,000.00", effectiveValue: "$5,230.29", latestReview: { action: "correct", correctedValue: "$5,230.29", note: null } },
    });
    expect(byKey.due_date).toMatchObject({
      reviewStatus: "carried_over",
      effectiveValue: "2025-10-14",
      latestReview: { action: "approve", note: "v1 check" },
      previous: { versionNo: 1, value: "2025-10-14", latestReview: { action: "approve", note: "v1 check" } },
    });
    expect(byKey.invoice_number).toMatchObject({ value: null, effectiveValue: null, latestReview: null, previous: { versionNo: 1, value: "INV-1", latestReview: null } });
    expect(typeof byKey.due_date.latestReview.createdAt).toBe("string");

    // Version 1 stays readable, with its own reviews.
    const old = await call(`/documents/${documentId}/versions/1`);
    expect(old.body).toMatchObject({ currentVersion: { versionNo: 2 }, version: { versionNo: 1, status: "superseded", parsedText: "text of v1" } });
    DocumentViewSchema.parse(old.body);
    const oldTotal = old.body.values.find((v: { fieldKey: string }) => v.fieldKey === "total_amount");
    expect(oldTotal).toMatchObject({ id: v1.total_amount, reviewStatus: "corrected", effectiveValue: "$5,230.29", previous: null });
    expect((await call(`/documents/${documentId}/versions/3`)).status).toBe(404);
    expect((await call(`/documents/${documentId}/versions/one`)).status).toBe(404);
    expect((await call(`/documents/test-${randomUUID()}/versions/1`)).status).toBe(404);
  });

  it("lists documents with the current version's error and review counts", async () => {
    const { documentId } = await seedTwoVersions();
    const failed = await seedInvoice([]);
    await db.documentVersion.update({ where: { id: failed.versionId }, data: { status: "failed", error: "llm_request_failed" } });

    const { status, body } = await call("/documents");
    expect(status).toBe(200);
    // Other test files share the database, so look only at this test's documents.
    const list = DocumentListSchema.parse(body);
    expect(list.find((d) => d.id === documentId)).toEqual({
      id: documentId, title: "review test", type: "invoice", versionNo: 2, status: "extracted", error: null, total: 5, pending: 2,
    });
    expect(list.find((d) => d.id === failed.documentId)).toMatchObject({ status: "failed", error: "llm_request_failed", total: 0, pending: 0 });
    // Newest first.
    expect(list.findIndex((d) => d.id === failed.documentId)).toBeLessThan(list.findIndex((d) => d.id === documentId));
  });

  it("counts the current version's review progress in one query, matching the rows", async () => {
    const { documentId } = await seedTwoVersions();
    const { body } = await call(`/documents/${documentId}/progress`);
    expect(body).toEqual({ versionNo: 2, status: "extracted", total: 5, pending: 2, approved: 1, corrected: 1, carriedOver: 1, gaps: 1 });
    ProgressSchema.parse(body);

    const rows = await db.extractedValue.findMany({ where: { version: { documentId, versionNo: 2 } } });
    const count = (s: ReviewStatus) => rows.filter((r) => r.reviewStatus === s).length;
    expect(body).toMatchObject({
      total: rows.length,
      pending: count("pending"),
      approved: count("approved"),
      corrected: count("corrected"),
      carriedOver: count("carried_over"),
      gaps: rows.filter((r) => r.value === null && r.reviewStatus === "pending").length,
    });

    const empty = await seedInvoice([]);
    expect((await call(`/documents/${empty.documentId}/progress`)).body).toEqual({
      versionNo: 1, status: "extracted", total: 0, pending: 0, approved: 0, corrected: 0, carriedOver: 0, gaps: 0,
    });
    expect((await call(`/documents/test-${randomUUID()}/progress`)).status).toBe(404);
  });

  it("never deadlocks a review racing a new version: it lands before the new version's commit sees reviews, or gets 409", async () => {
    const pdf = new File(["%PDF-1.7 version 2"], "v2.pdf", { type: "application/pdf" });
    const noop = async () => {};

    /** The worker's commit (apps/worker/src/extract.ts, step 6): the document lock, then what carry-over will read. */
    const commitLikeTheWorker = (documentId: string, versionId: string, previousValueId: string) =>
      db.$transaction(async (tx) => {
        const [doc] = await tx.$queryRaw<{ current_version_id: string }[]>`
          SELECT current_version_id FROM documents WHERE id = ${documentId} FOR UPDATE`;
        expect(doc!.current_version_id).toBe(versionId);
        const reviewsSeen = await tx.review.count({ where: { valueId: previousValueId } });
        await tx.extractedValue.create({ data: { versionId, fieldKey: "invoice_number", value: "INV-1", previousValueId } });
        await tx.documentVersion.update({ where: { id: versionId }, data: { status: "extracted" } });
        return reviewsSeen;
      });

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const { documentId, ids } = await seedInvoice([{ fieldKey: "invoice_number", value: "INV-1" }]);
        const valueId = ids.invoice_number!;
        // Started together, the upload nearly always wins; a head start for half the reviews exercises both orders.
        const headStart = new Promise((resolve) => setTimeout(resolve, i % 2 ? 0 : 50));
        const [r, reviewsSeen] = await Promise.all([
          review(valueId, { action: "approve" }),
          headStart
            .then(() => createVersion({ putObject: noop, db, enqueue: noop }, { documentId }, pdf))
            .then((v) => commitLikeTheWorker(documentId, v.versionId, valueId)),
        ]);
        if (r.status === 200) {
          expect(reviewsSeen).toBe(1);
        } else {
          expect(r).toEqual({ status: 409, body: { error: "stale_version", currentVersionNo: 2 } });
          expect(reviewsSeen).toBe(0);
          expect(await reviewRows(valueId)).toHaveLength(0);
        }
        return r.status;
      }),
    );
    console.log(`review vs new version: ${outcomes.filter((s) => s === 200).length} reviews first, ${outcomes.filter((s) => s === 409).length} 409s`);
  });
});
