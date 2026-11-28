import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { ExpectedFieldsSchema, type Llm, type LlmField } from "@lomi/core";
import { createDb, type PrismaClient } from "@lomi/db";
import { processVersion } from "@lomi/worker/extract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createVersion, type CreateVersionDeps } from "../src/create-version.js";

// Spec 005 end to end in one process: uploads and reviews through the HTTP API, extraction by the worker's
// processVersion with a fake model. Runs against a dedicated test database (see spec 007):
// TEST_DATABASE_URL=postgres://lomi:lomi@127.0.0.1:5433/lomi_test
const dbUrl = process.env.TEST_DATABASE_URL;
const fixture = (path: string) => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url));
const fields = ExpectedFieldsSchema.parse(JSON.parse(fixture("expected-fields.json").toString()));
const invoiceV1 = () => new File([fixture("documents/invoice-001.pdf")], "invoice-001.pdf", { type: "application/pdf" });
const invoiceV2 = () => new File([fixture("documents/invoice-001.v2.pdf")], "invoice-001.v2.pdf", { type: "application/pdf" });

const v1Answer: LlmField[] = [
  { key: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", reason: null },
  { key: "issue_date", value: "2025-09-14", evidence: "Issue Date: 2025-09-14", reason: null },
  { key: "due_date", value: "2025-10-14", evidence: "Due Date: 2025-10-14", reason: null },
  { key: "vendor_name", value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
  { key: "total_amount", value: "$5,230.29", evidence: "Total Due: $5,230.29", reason: null },
];
// The revised invoice moves the due date and the total. The model quotes a longer span for the unchanged
// issue date, as a real model may, so that field carries over because its old evidence is still in the text.
const v2Answer: LlmField[] = [
  { key: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", reason: null },
  { key: "issue_date", value: "2025-09-14", evidence: "Invoice Number: INV-2025-0847\nIssue Date: 2025-09-14", reason: null },
  { key: "due_date", value: "2025-11-13", evidence: "Due Date: 2025-11-13", reason: null },
  { key: "vendor_name", value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
  { key: "total_amount", value: "$6,126.45", evidence: "Total Due: $6,126.45", reason: null },
];

/** A fake model that answers for the invoice it is shown, after running `during` (to interleave an upload). */
const fakeLlm =
  (during?: () => Promise<void>): Llm =>
  async (prompt) => {
    await during?.();
    const answer = prompt.user.includes("INVOICE (REVISED)") ? v2Answer : v1Answer;
    return { raw: '{"fake":true}', text: JSON.stringify({ fields: answer }), stopReason: "end_turn", tokensIn: 100, tokensOut: 50 };
  };

interface Json {
  status: number;
  body: any;
}

describe.skipIf(!dbUrl)("new versions and carry-over, through the API and the worker", () => {
  let db: PrismaClient;
  let server: Server;
  let base: string;
  const objects = new Map<string, Uint8Array>();
  /** Versions enqueued by uploads, in order; `work` extracts the oldest. */
  const queued: string[] = [];
  const documentIds: string[] = [];

  beforeAll(async () => {
    db = createDb(dbUrl!);
    const versionDeps: CreateVersionDeps = {
      putObject: async (key, body) => void objects.set(key, new Uint8Array(body)),
      db,
      enqueue: async (versionId) => void queued.push(versionId),
    };
    const unused = async () => {
      throw new Error("not used here");
    };
    server = createApp({
      checks: { db: unused, redis: unused },
      db,
      fields,
      createVersion: (target, file) => createVersion(versionDeps, target, file),
      retry: unused,
    }).listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    const ofDocs = { version: { documentId: { in: documentIds } } };
    await db.review.deleteMany({ where: { value: ofDocs } });
    await db.extractedValue.deleteMany({ where: ofDocs });
    await db.extractionRun.deleteMany({ where: ofDocs });
    await db.document.updateMany({ where: { id: { in: documentIds } }, data: { currentVersionId: null } });
    await db.documentVersion.deleteMany({ where: { documentId: { in: documentIds } } });
    await db.document.deleteMany({ where: { id: { in: documentIds } } });
    server.close();
    await db.$disconnect();
  });

  /** The worker: one extraction attempt of the oldest queued version. */
  const work = (llm = fakeLlm()) =>
    processVersion({ db, getObject: async (key) => objects.get(key)!, llm, model: "fake-model", fields, leaseSeconds: 60 }, queued.shift()!);

  async function call(path: string, init?: RequestInit): Promise<Json> {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() };
  }
  const get = (path: string) => call(path);
  const review = (valueId: string, body: object) =>
    call(`/values/${valueId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  function upload(path: string, file: File, type?: string) {
    const body = new FormData();
    if (type) body.append("type", type);
    body.append("file", file);
    return call(path, { method: "POST", body });
  }
  const uploadVersion = (documentId: string, file: File) => upload(`/documents/${documentId}/versions`, file);

  /** Uploads version 1 of the invoice and extracts it. */
  async function extractedInvoice() {
    const r = await upload("/documents", invoiceV1(), "invoice");
    expect(r).toMatchObject({ status: 202, body: { versionNo: 1, status: "queued" } });
    documentIds.push(r.body.id);
    expect(await work()).toBe("extracted");
    const { body } = await get(`/documents/${r.body.id}`);
    const ids: Record<string, string> = Object.fromEntries(body.values.map((v: { fieldKey: string; id: string }) => [v.fieldKey, v.id]));
    return { documentId: r.body.id as string, versionId: r.body.versionId as string, ids };
  }

  const keysWith = (values: { fieldKey: string; reviewStatus: string }[], status: string) =>
    values
      .filter((v) => v.reviewStatus === status)
      .map((v) => v.fieldKey)
      .sort();

  it("carries every review to the revised invoice except on the 2 changed fields, and leaves version 1 as it was", async () => {
    const { documentId, versionId: v1Id, ids } = await extractedInvoice();
    const reviews = {
      invoice_number: { action: "approve", note: "matches the PDF" },
      issue_date: { action: "approve" },
      due_date: { action: "approve" },
      vendor_name: { action: "correct", correctedValue: "Meridian Office Supplies LLC", note: "legal name casing" },
      total_amount: { action: "correct", correctedValue: "5230.29", note: "plain number" },
    };
    for (const [key, body] of Object.entries(reviews)) expect((await review(ids[key]!, body)).status).toBe(200);

    const ofV1 = { where: { versionId: v1Id }, orderBy: { fieldKey: "asc" } } as const;
    const v1Before = {
      read: (await get(`/documents/${documentId}/versions/1`)).body,
      values: await db.extractedValue.findMany(ofV1),
      reviews: await db.review.findMany({ where: { value: { versionId: v1Id } }, orderBy: { createdAt: "asc" } }),
    };
    expect(v1Before.reviews).toHaveLength(5);

    const v2 = await uploadVersion(documentId, invoiceV2());
    expect(v2).toEqual({ status: 202, body: { id: documentId, versionId: expect.any(String), versionNo: 2, status: "queued" } });
    expect(await work()).toBe("extracted");

    const { body: doc } = await get(`/documents/${documentId}`);
    expect(doc.version).toMatchObject({ id: v2.body.versionId, versionNo: 2, status: "extracted" });
    expect(keysWith(doc.values, "pending")).toEqual(["due_date", "total_amount"]);
    expect(keysWith(doc.values, "carried_over")).toEqual(["invoice_number", "issue_date", "vendor_name"]);
    const byKey = Object.fromEntries(doc.values.map((v: { fieldKey: string }) => [v.fieldKey, v]));

    // Changed: pending, with version 1's value and review beside the new value.
    expect(byKey.due_date).toMatchObject({
      value: "2025-11-13",
      effectiveValue: "2025-11-13",
      latestReview: null,
      previous: { versionNo: 1, value: "2025-10-14", effectiveValue: "2025-10-14", latestReview: { action: "approve", correctedValue: null, note: null } },
    });
    expect(byKey.total_amount).toMatchObject({
      value: "$6,126.45",
      effectiveValue: "$6,126.45",
      latestReview: null,
      previous: { versionNo: 1, value: "$5,230.29", effectiveValue: "5230.29", latestReview: { action: "correct", correctedValue: "5230.29", note: "plain number" } },
    });

    // Unchanged: the review came along, a correction included, and the old value is still linked.
    expect(byKey.invoice_number).toMatchObject({
      effectiveValue: "INV-2025-0847",
      latestReview: { action: "approve", correctedValue: null, note: "matches the PDF" },
      previous: { versionNo: 1, value: "INV-2025-0847" },
    });
    expect(byKey.issue_date).toMatchObject({ evidence: "Invoice Number: INV-2025-0847\nIssue Date: 2025-09-14", latestReview: { action: "approve" } });
    expect(byKey.vendor_name).toMatchObject({
      value: "MERIDIAN OFFICE SUPPLIES LLC",
      effectiveValue: "Meridian Office Supplies LLC",
      latestReview: { action: "correct", correctedValue: "Meridian Office Supplies LLC", note: "legal name casing" },
      previous: { versionNo: 1, effectiveValue: "Meridian Office Supplies LLC" },
    });

    // Each carried review is a new row on the new value, pointing at the review it was copied from.
    const carried = await db.review.findMany({
      where: { value: { versionId: v2.body.versionId } },
      select: { carriedFromReviewId: true, value: { select: { fieldKey: true } } },
    });
    const originalOf = (key: string) => v1Before.reviews.find((r) => r.valueId === ids[key])!.id;
    expect(carried.map((r) => [r.value.fieldKey, r.carriedFromReviewId]).sort()).toEqual(
      ["invoice_number", "issue_date", "vendor_name"].map((key) => [key, originalOf(key)]),
    );
    expect((await get(`/documents/${documentId}/progress`)).body).toEqual({
      versionNo: 2, status: "extracted", total: 5, pending: 2, approved: 0, corrected: 0, carriedOver: 3, gaps: 0,
    });

    // Version 1, its values and its reviews are untouched, and still readable by number.
    const v1After = (await get(`/documents/${documentId}/versions/1`)).body;
    expect(v1After.version).toEqual(v1Before.read.version);
    expect(v1After.values).toEqual(v1Before.read.values);
    expect(v1After.currentVersion).toMatchObject({ versionNo: 2 });
    expect(await db.extractedValue.findMany(ofV1)).toEqual(v1Before.values);
    expect(await db.review.findMany({ where: { value: { versionId: v1Id } }, orderBy: { createdAt: "asc" } })).toEqual(v1Before.reviews);

    // The same bytes as the current version again, or an unknown document, write nothing.
    expect(await uploadVersion(documentId, invoiceV2())).toEqual({ status: 409, body: { error: "identical_to_current" } });
    expect(await uploadVersion(`test-${randomUUID()}`, invoiceV2())).toEqual({ status: 404, body: { error: "document not found" } });
    expect(queued).toEqual([]);
    expect(await db.documentVersion.count({ where: { documentId } })).toBe(2);
  });

  it("supersedes version 1 when version 2 is uploaded while it is extracting; version 2 has no base to carry from", async () => {
    const r = await upload("/documents", invoiceV1(), "invoice");
    const documentId: string = r.body.id;
    documentIds.push(documentId);
    let v2: Json | undefined;
    expect(await work(fakeLlm(async () => void (v2 = await uploadVersion(documentId, invoiceV2()))))).toBe("superseded");
    expect(v2).toMatchObject({ status: 202, body: { versionNo: 2 } });

    expect(await work()).toBe("extracted");
    const { body: doc } = await get(`/documents/${documentId}`);
    expect(doc.values).toHaveLength(5);
    for (const v of doc.values) expect(v).toMatchObject({ reviewStatus: "pending", latestReview: null, previous: null });
    expect((await get(`/documents/${documentId}/versions/1`)).body).toMatchObject({ version: { status: "superseded" }, values: [] });
  });

  it("carries over from the latest extracted version, skipping a version superseded while it was extracting", async () => {
    const { documentId, ids } = await extractedInvoice();
    for (const id of Object.values(ids)) await review(id, { action: "approve" });

    // Version 2 (the revision) is overtaken by version 3 (the original bytes again) before it commits.
    expect((await uploadVersion(documentId, invoiceV2())).body.versionNo).toBe(2);
    let v3: Json | undefined;
    expect(await work(fakeLlm(async () => void (v3 = await uploadVersion(documentId, invoiceV1()))))).toBe("superseded");
    expect(v3).toMatchObject({ status: 202, body: { versionNo: 3 } });
    expect(await work()).toBe("extracted");

    const { body: doc } = await get(`/documents/${documentId}`);
    expect(doc.version).toMatchObject({ versionNo: 3, status: "extracted" });
    expect(keysWith(doc.values, "carried_over")).toEqual(Object.keys(ids).sort());
    for (const v of doc.values) expect(v.previous).toMatchObject({ versionNo: 1, latestReview: { action: "approve" } });
  });
});
