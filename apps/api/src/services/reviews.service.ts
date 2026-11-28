import type { PrismaClient } from "@lomi/db";
import type { ReviewInput } from "@lomi/shared";
import type { ReviewResult } from "../types/reviews.js";
import { toValueView, valueSelect } from "./value-view.js";

/** Records a review of a value of the current, extracted version (spec 004). Never changes the value itself. */
export async function reviewValue(db: PrismaClient, valueId: string, input: ReviewInput): Promise<ReviewResult> {
  return db.$transaction(async (tx) => {
    const target = await tx.extractedValue.findUnique({ where: { id: valueId }, select: { versionId: true, version: { select: { documentId: true } } } });
    if (!target) return "not_found";
    const { documentId } = target.version;

    // The worker's commit takes this lock too, and an upload's version insert waits on it through the foreign key:
    // no new version, and no other review of this document, interleaves. Every read below is a new statement,
    // so it sees whatever committed before the lock was ours.
    // A deleted document's values are not found (spec 011); checked under the lock, so no review lands after a delete.
    const locked = await tx.$queryRaw<unknown[]>`SELECT 1 FROM documents WHERE id = ${documentId} AND deleted_at IS NULL FOR UPDATE`;
    if (!locked.length) return "not_found";
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
