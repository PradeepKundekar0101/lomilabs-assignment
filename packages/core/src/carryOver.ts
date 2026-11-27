import { norm, type ValidatedValue } from "./evidence.js";

export interface BaseReview {
  id: string;
  action: "approve" | "correct";
  correctedValue: string | null;
  note: string | null;
}

/** A value of the base version (the latest earlier extracted version), with its latest review. */
export interface BaseValue {
  id: string;
  fieldKey: string;
  value: string | null;
  evidence: string | null;
  latestReview: BaseReview | null;
}

export interface CarriedReview {
  action: BaseReview["action"];
  correctedValue: string | null;
  note: string | null;
  carriedFromReviewId: string;
}

export interface CarryOver {
  reviewStatus: "pending" | "carried_over";
  previousValueId: string | null;
  carriedReview: CarriedReview | null;
}

/** Both null, or equal after norm(). */
const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : norm(a) === norm(b));

/**
 * Links each new value to the base version's value of the same field, and carries that value's latest
 * review forward when the field did not change (spec 005). Unchanged means the same value, backed by the
 * same evidence or by old evidence that is still in the new text; a gap that stays a gap is unchanged too.
 * Returns one result per `next` value, in the same order.
 */
export function carryOver(base: BaseValue[], next: ValidatedValue[], nextText: string): CarryOver[] {
  const byKey = new Map(base.map((p) => [p.fieldKey, p]));
  const text = norm(nextText);
  return next.map((n) => {
    const p = byKey.get(n.fieldKey);
    const unchanged =
      p !== undefined && same(p.value, n.value) && (same(p.evidence, n.evidence) || (p.evidence !== null && text.includes(norm(p.evidence))));
    const review = unchanged ? p.latestReview : null;
    return {
      reviewStatus: review ? "carried_over" : "pending",
      previousValueId: p?.id ?? null,
      carriedReview: review && { action: review.action, correctedValue: review.correctedValue, note: review.note, carriedFromReviewId: review.id },
    };
  });
}
