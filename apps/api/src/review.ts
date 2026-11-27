import type { ExpectedField } from "@lomi/core";
import type { Prisma, PrismaClient, ReviewStatus } from "@lomi/db";
import { z } from "zod";

const note = z.string().max(1000).optional();

/** Strict, so an approve that carries a correctedValue is rejected rather than silently stripped. */
export const ReviewInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), note }),
  z.strictObject({ action: z.literal("correct"), correctedValue: z.string().trim().min(1), note }),
]);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

const latestReview = {
  select: { action: true, correctedValue: true, note: true, createdAt: true },
  orderBy: { createdAt: "desc" },
  take: 1,
} as const satisfies Prisma.ExtractedValue$reviewsArgs;

const valueSelect = {
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

type StoredValue = Prisma.ExtractedValueGetPayload<{ select: typeof valueSelect }>;
type LatestReview = StoredValue["reviews"][number];

/** A correction lives beside the model's value: the latest review's correctedValue wins, if it is a correct. */
const effective = (value: string | null, review: LatestReview | undefined) => (review?.action === "correct" ? review.correctedValue : value);

function toValueView({ reviews: [review], previousValue: prev, ...value }: StoredValue) {
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
export type ValueView = ReturnType<typeof toValueView>;

const STATUS_ORDER: ReviewStatus[] = ["pending", "corrected", "approved", "carried_over"];

/** Pending first (gaps last among them), then corrected, approved, carried over; expected-field order within each. */
function sortForReview(values: ValueView[], expected: ExpectedField[] = []) {
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

const versionSelect = { id: true, versionNo: true, status: true, error: true, attempts: true, createdAt: true } as const;

/** A document with one version's values: the current version, or version `versionNo`. Null when either is missing. */
export async function documentView(db: PrismaClient, fields: Record<string, ExpectedField[]>, documentId: string, versionNo?: number) {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, title: true, type: true, createdAt: true, currentVersion: { select: versionSelect } },
  });
  if (!doc) return null;
  const version =
    versionNo === undefined
      ? doc.currentVersion
      : await db.documentVersion.findUnique({ where: { documentId_versionNo: { documentId, versionNo } }, select: versionSelect });
  if (versionNo !== undefined && !version) return null;
  const values = version ? await db.extractedValue.findMany({ where: { versionId: version.id }, select: valueSelect }) : [];
  return { ...doc, version, values: sortForReview(values.map(toValueView), fields[doc.type]) };
}

export type ReviewResult = ValueView | "not_found" | { staleVersion: number | null };

/** Records a review of a value of the current, extracted version (spec 004). Never changes the value itself. */
export async function reviewValue(db: PrismaClient, valueId: string, input: ReviewInput): Promise<ReviewResult> {
  return db.$transaction(async (tx) => {
    const target = await tx.extractedValue.findUnique({ where: { id: valueId }, select: { versionId: true, version: { select: { documentId: true } } } });
    if (!target) return "not_found";
    const { documentId } = target.version;

    // The worker's commit takes this lock too, and an upload's version insert waits on it through the foreign key:
    // no new version, and no other review of this document, interleaves. Every read below is a new statement,
    // so it sees whatever committed before the lock was ours.
    await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId} FOR UPDATE`;
    const { currentVersion } = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { currentVersion: { select: { id: true, versionNo: true, status: true } } },
    });
    if (currentVersion?.id !== target.versionId || currentVersion.status !== "extracted") {
      return { staleVersion: currentVersion?.versionNo ?? null };
    }

    const status = input.action === "approve" ? "approved" : "corrected";
    const correctedValue = input.action === "correct" ? input.correctedValue : null;
    const note = input.note ?? null;
    const before = await tx.extractedValue.findUniqueOrThrow({ where: { id: valueId }, select: valueSelect });
    const [last] = before.reviews;
    // A repeat of the latest review (a double click) changes nothing; a carried-over value still takes the review.
    if (before.reviewStatus === status && last?.action === input.action && last.correctedValue === correctedValue && last.note === note) {
      return toValueView(before);
    }

    // clock_timestamp(), not now(): the lock orders reviews, and a later-started transaction can win it.
    await tx.$executeRaw`
      INSERT INTO reviews (value_id, action, corrected_value, note, created_at)
      VALUES (${valueId}::uuid, ${input.action}::review_action, ${correctedValue}, ${note}, clock_timestamp())`;
    return toValueView(await tx.extractedValue.update({ where: { id: valueId }, data: { reviewStatus: status }, select: valueSelect }));
  });
}

export interface Progress {
  versionNo: number | null;
  status: string | null;
  total: number;
  pending: number;
  approved: number;
  corrected: number;
  carriedOver: number;
  gaps: number;
}

/** Review counts for the document's current version, in one query. Null for an unknown document. */
export async function documentProgress(db: PrismaClient, documentId: string): Promise<Progress | null> {
  const [progress] = await db.$queryRaw<Progress[]>`
    SELECT v.version_no AS "versionNo", v.status::text AS status,
      count(ev.id)::int AS total,
      count(*) FILTER (WHERE ev.review_status = 'pending')::int AS pending,
      count(*) FILTER (WHERE ev.review_status = 'approved')::int AS approved,
      count(*) FILTER (WHERE ev.review_status = 'corrected')::int AS corrected,
      count(*) FILTER (WHERE ev.review_status = 'carried_over')::int AS "carriedOver",
      count(*) FILTER (WHERE ev.review_status = 'pending' AND ev.value IS NULL)::int AS gaps
    FROM documents d
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    LEFT JOIN extracted_values ev ON ev.version_id = v.id
    WHERE d.id = ${documentId}
    GROUP BY v.id`;
  return progress ?? null;
}
