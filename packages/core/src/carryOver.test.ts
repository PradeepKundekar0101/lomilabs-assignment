import { describe, expect, it } from "vitest";
import { carryOver, type BaseReview, type BaseValue } from "./carryOver.js";
import type { ValidatedValue } from "./evidence.js";

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
