import type { ExpectedField } from "@lomi/core";
import type { Prisma, ReviewStatus } from "@lomi/db";
import type { LatestReview, StoredValue, ValueView } from "../types/reviews.js";

const latestReview = {
  select: { action: true, correctedValue: true, note: true, createdAt: true },
  orderBy: { createdAt: "desc" },
  take: 1,
} as const satisfies Prisma.ExtractedValue$reviewsArgs;

/** What every read of a value selects: the value, its latest review, and its previous version's value. */
export const valueSelect = {
  id: true,
  fieldKey: true,
  value: true,
  evidence: true,
  evidenceStart: true,
  evidenceEnd: true,
  gapReason: true,
  reviewStatus: true,
  reviews: latestReview,
  previousValue: { select: { value: true, version: { select: { versionNo: true } }, reviews: latestReview } },
} as const satisfies Prisma.ExtractedValueSelect;

/** A correction lives beside the model's value: the latest review's correctedValue wins, if it is a correct. */
const effective = (value: string | null, review: LatestReview | undefined) => (review?.action === "correct" ? review.correctedValue : value);

export function toValueView({ reviews: [review], previousValue: prev, ...value }: StoredValue) {
  return {
    ...value,
    effectiveValue: effective(value.value, review),
    latestReview: review ?? null,
    previous: prev && {
      versionNo: prev.version.versionNo,
      value: prev.value,
      effectiveValue: effective(prev.value, prev.reviews[0]),
      latestReview: prev.reviews[0] ?? null,
    },
  };
}

const STATUS_ORDER: ReviewStatus[] = ["pending", "corrected", "approved", "carried_over"];

/** Pending first (gaps last among them), then corrected, approved, carried over; expected-field order within each. */
export function sortForReview(values: ValueView[], expected: ExpectedField[] = []) {
  const fieldOrder = expected.map((f) => f.field);
  const key = (v: ValueView) => [
    STATUS_ORDER.indexOf(v.reviewStatus),
    Number(v.reviewStatus === "pending" && v.value === null),
    fieldOrder.indexOf(v.fieldKey),
  ];
  return values.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0]! - kb[0]! || ka[1]! - kb[1]! || ka[2]! - kb[2]!;
  });
}
