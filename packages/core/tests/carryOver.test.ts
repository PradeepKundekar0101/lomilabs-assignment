import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { carryOver, type BaseReview, type BaseValue } from "../src/carryOver.js";
import { validateEvidence, type ValidatedValue } from "../src/evidence.js";
import type { LlmField } from "../src/llm.js";
import { extractPdfText } from "../src/pdf.js";

const approve: BaseReview = { id: "review-1", action: "approve", correctedValue: null, note: "checked" };
const correct: BaseReview = { id: "review-2", action: "correct", correctedValue: "2025-10-15", note: "typo on the PDF" };

const base = (value: string | null, evidence: string | null, latestReview: BaseReview | null = approve): BaseValue => ({
  id: "value-1",
  fieldKey: "due_date",
  value,
  evidence,
  latestReview,
});
// Offsets do not matter to carry-over.
const next = (value: string | null, evidence: string | null): ValidatedValue => ({
  fieldKey: "due_date",
  value,
  evidence,
  evidenceStart: evidence === null ? null : 0,
  evidenceEnd: evidence === null ? null : evidence.length,
  gapReason: value === null ? "not_found" : null,
});

const v1Evidence = "Due Date: 2025-10-14";
const text = "INVOICE\nInvoice Number: INV-2025-0847\nDue Date: 2025-10-14\nPayment Terms: Net 30";

describe("carryOver", () => {
  const cases: { name: string; base: BaseValue; next: ValidatedValue; text?: string; carried: boolean }[] = [
    { name: "same value, same evidence, reviewed", base: base("2025-10-14", v1Evidence), next: next("2025-10-14", v1Evidence), carried: true },
    {
      name: "same value, a different span quoted, old evidence still in the new text",
      base: base("2025-10-14", v1Evidence),
      next: next("2025-10-14", "2025-10-14\nPayment Terms"),
      carried: true,
    },
    {
      name: "same value, old evidence gone from the new text",
      base: base("2025-10-14", v1Evidence),
      next: next("2025-10-14", "Payment due 2025-10-14"),
      text: "INVOICE\nPayment due 2025-10-14",
      carried: false,
    },
    { name: "value changed", base: base("2025-10-14", v1Evidence), next: next("2025-11-13", "Due Date: 2025-11-13"), carried: false },
    { name: "same evidence, different value (model inconsistency)", base: base("2025-10-14", v1Evidence), next: next("2025-10-15", v1Evidence), carried: false },
    { name: "gap stays a gap, and the gap was reviewed", base: base(null, null), next: next(null, null), carried: true },
    { name: "value becomes a gap", base: base("2025-10-14", v1Evidence), next: next(null, null), carried: false },
    { name: "gap becomes a value", base: base(null, null), next: next("2025-10-14", v1Evidence), carried: false },
    { name: "unchanged but never reviewed", base: base("2025-10-14", v1Evidence, null), next: next("2025-10-14", v1Evidence), carried: false },
    {
      name: "whitespace in value and evidence differs only",
      base: base("2025-10-14", v1Evidence),
      next: next(" 2025-10-14 ", "Due   Date:\n2025-10-14"),
      carried: true,
    },
    {
      name: "same value, a short old quote still in the new text, a different quote now",
      base: base("14", "10-14"),
      next: next("14", "Due Date: 2025-10-14"),
      carried: false,
    },
    { name: "same value, the same short quote", base: base("14", "10-14"), next: next("14", "10-14"), carried: true },
    {
      name: "the whole text shifted (lines added above, re-wrapped), values unchanged",
      base: base("2025-10-14", "Due Date: 2025-10-14 Payment Terms: Net 30"),
      next: next("2025-10-14", "Due Date: 2025-10-14"),
      text: "INVOICE (REVISED)\nThis revision adds a line above.\nInvoice Number: INV-2025-0847 Due\nDate: 2025-10-14 Payment\nTerms: Net 30",
      carried: true,
    },
  ];

  it.each(cases)("$name", ({ base: p, next: n, text: nextText = text, carried }) => {
    const [result] = carryOver([p], [n], nextText);
    expect(result).toEqual({
      reviewStatus: carried ? "carried_over" : "pending",
      // Always linked, so the reviewer sees the old value and its review beside a changed one.
      previousValueId: "value-1",
      carriedReview: carried ? { action: "approve", correctedValue: null, note: "checked", carriedFromReviewId: "review-1" } : null,
    });
  });

  it("carries a correction, so the effective value stays the corrected one", () => {
    const [result] = carryOver([base("2025-10-14", v1Evidence, correct)], [next("2025-10-14", v1Evidence)], text);
    expect(result).toMatchObject({
      reviewStatus: "carried_over",
      carriedReview: { action: "correct", correctedValue: "2025-10-15", note: "typo on the PDF", carriedFromReviewId: "review-2" },
    });
  });

  it("leaves a field the base version did not have pending, with no previous value", () => {
    const [result] = carryOver([base("2025-10-14", v1Evidence)], [{ ...next("Net 30", "Payment Terms: Net 30"), fieldKey: "terms" }], text);
    expect(result).toMatchObject({ reviewStatus: "pending", previousValueId: null, carriedReview: null });
  });

  it("leaves everything pending with no previous value when there is no base version", () => {
    const pending = { reviewStatus: "pending", previousValueId: null, carriedReview: null };
    expect(carryOver([], [next("2025-10-14", v1Evidence), next(null, null)], text)).toEqual([pending, pending]);
  });

  it("matches fields by key, whatever their order, and answers in the order of the new values", () => {
    const other: BaseValue = { ...base("INV-2025-0847", "Invoice Number: INV-2025-0847"), id: "value-2", fieldKey: "invoice_number" };
    const results = carryOver(
      [other, base("2025-10-14", v1Evidence)],
      [next("2025-11-13", "Due Date: 2025-11-13"), { ...next("INV-2025-0847", "Invoice Number: INV-2025-0847"), fieldKey: "invoice_number" }],
      text,
    );
    expect(results.map((r) => [r.reviewStatus, r.previousValueId])).toEqual([
      ["pending", "value-1"],
      ["carried_over", "value-2"],
    ]);
  });
});

describe("carryOver on the fixture invoice, v1 to v2", () => {
  const parse = async (name: string) =>
    extractPdfText(new Uint8Array(await readFile(new URL(`../../../fixtures/documents/${name}`, import.meta.url))));
  const answer = (dueDate: string, total: string): LlmField[] => [
    { key: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", reason: null },
    { key: "issue_date", value: "2025-09-14", evidence: "Issue Date: 2025-09-14", reason: null },
    { key: "due_date", value: dueDate, evidence: `Due Date: ${dueDate}`, reason: null },
    { key: "vendor_name", value: "MERIDIAN OFFICE SUPPLIES LLC", evidence: "MERIDIAN OFFICE SUPPLIES LLC", reason: null },
    { key: "total_amount", value: total, evidence: `Total Due: ${total}`, reason: null },
  ];
  const invoiceFields = ["invoice_number", "issue_date", "due_date", "vendor_name", "total_amount"].map((field) => ({ field, type: "string" }));

  it("leaves exactly the due date and the total pending", async () => {
    const [v1Text, v2Text] = await Promise.all([parse("invoice-001.pdf"), parse("invoice-001.v2.pdf")]);
    const v1 = validateEvidence(v1Text, invoiceFields, answer("2025-10-14", "$5,230.29")).values;
    const v2 = validateEvidence(v2Text, invoiceFields, answer("2025-11-13", "$6,126.45")).values;
    expect([...v1, ...v2].every((v) => v.gapReason === null)).toBe(true);

    const reviewed = v1.map((v, i): BaseValue => ({ ...v, id: `value-${i}`, latestReview: approve }));
    const results = carryOver(reviewed, v2, v2Text);
    expect(v2.filter((_, i) => results[i]!.reviewStatus === "pending").map((v) => v.fieldKey)).toEqual(["due_date", "total_amount"]);
  });
});
