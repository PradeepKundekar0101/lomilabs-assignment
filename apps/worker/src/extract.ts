import {
  buildPrompt,
  carryOver,
  ExtractionError,
  extractPdfText,
  parseLlmOutput,
  validateEvidence,
} from "@lomi/core";
import type { PrismaClient } from "@lomi/db";
import { z } from "zod";
import { ExtractJobSchema } from "./schemas/job.schema.js";
import type { ClaimedVersion, ExtractDeps, ExtractOutcome } from "./types/extract.js";

/** Claims allowed per version before it is failed: only attempts that never finished (a crash) reach it. */
export const MAX_ATTEMPTS = 3;

/** Runs a queue job. Its data must be an `ExtractJob`; anything else is logged and skipped, since no retry can fix it. */
export async function processJob(deps: ExtractDeps, jobId: string | undefined, data: unknown): Promise<ExtractOutcome | "skipped"> {
  const job = ExtractJobSchema.safeParse(data);
  if (!job.success) {
    console.error(`job ${jobId}: invalid data, skipped\n${z.prettifyError(job.error)}`);
    return "skipped";
  }
  return processVersion(deps, job.data.versionId);
}

/** Runs one extraction attempt for a version (specs 003, 007). Never throws for an extraction failure. */
export async function processVersion(deps: ExtractDeps, versionId: string): Promise<ExtractOutcome> {
  const { db } = deps;

  // 1. Claim: only a queued version, or one whose previous attempt's lease ran out, with attempts left.
  const lease = deps.leaseSeconds;
  const [version] = await db.$queryRaw<ClaimedVersion[]>`
    UPDATE document_versions
    SET status = 'extracting', lease_until = now() + make_interval(secs => ${lease}),
        attempts = attempts + 1, error = null, updated_at = now()
    WHERE id = ${versionId}::uuid AND attempts < ${MAX_ATTEMPTS}
      AND (status = 'queued' OR (status = 'extracting' AND lease_until < now()))
    RETURNING id, document_id, version_no, storage_key, attempts`;
  if (!version) {
    // Claimable but out of attempts: every earlier attempt died mid-way (e.g. a PDF that crashes the worker).
    const gaveUp = await db.$executeRaw`
      UPDATE document_versions
      SET status = 'failed', error = ${`too_many_attempts: ${MAX_ATTEMPTS} attempts did not finish`}, lease_until = null, updated_at = now()
      WHERE id = ${versionId}::uuid AND attempts >= ${MAX_ATTEMPTS}
        AND (status = 'queued' OR (status = 'extracting' AND lease_until < now()))`;
    console.log(`version ${versionId}: ${gaveUp ? "failed, too many attempts" : "not claimable"}`);
    return gaveUp ? "failed" : "not_claimable";
  }
  const run = await db.extractionRun.create({
    data: { versionId, attempt: version.attempts, model: deps.model },
    select: { id: true },
  });
  // Keeps the claim while this attempt runs; once this process dies, the lease expires and the reconciler re-enqueues.
  const heartbeat = setInterval(() => {
    db.$executeRaw`
      UPDATE document_versions SET lease_until = now() + make_interval(secs => ${lease})
      WHERE id = ${versionId}::uuid AND status = 'extracting'`.catch((err) => console.error(`version ${versionId}: heartbeat failed`, err));
  }, (lease * 1000) / 3).unref();

  const supersede = async (tx: Pick<PrismaClient, "documentVersion" | "extractionRun"> = db) => {
    await tx.documentVersion.update({ where: { id: versionId }, data: { status: "superseded", leaseUntil: null } });
    await tx.extractionRun.update({ where: { id: run.id }, data: { outcome: "superseded", finishedAt: new Date() } });
    console.log(`version ${versionId}: superseded, no values written`);
    return "superseded" as const;
  };
  const isCurrent = async (tx: Pick<PrismaClient, "$queryRaw"> = db) => {
    const [doc] = await tx.$queryRaw<{ current_version_id: string | null }[]>`
      SELECT current_version_id FROM documents WHERE id = ${version.document_id} FOR UPDATE`;
    return doc?.current_version_id === versionId;
  };

  try {
    // 2. Parse. Saved on its own so the text survives a later failure.
    const parsedText = await extractPdfText(await deps.getObject(version.storage_key));
    await db.documentVersion.update({ where: { id: versionId }, data: { parsedText } });

    // 3. Don't spend on the model for a version a newer upload already replaced.
    if (!(await isCurrent())) return await supersede();

    // 4. Model call. Prompt and raw response are saved before anything can fail on them.
    const { type } = await db.document.findUniqueOrThrow({ where: { id: version.document_id }, select: { type: true } });
    const expected = deps.fields[type];
    if (!expected) throw new ExtractionError("unknown_document_type", `no expected fields for type ${type}`);
    const prompt = buildPrompt(expected, parsedText);
    await db.extractionRun.update({ where: { id: run.id }, data: { prompt: `${prompt.system}\n\n${prompt.user}` } });
    const response = await deps.llm(prompt);
    await db.extractionRun.update({ where: { id: run.id }, data: { rawResponse: response.raw } });

    // 5. Keep only values whose evidence is really in the text.
    const { values, dropped } = validateEvidence(parsedText, expected, parseLlmOutput(response));
    if (dropped.length) console.warn(`version ${versionId}: dropped unexpected fields ${dropped.join(", ")}`);

    // 6. Commit, unless a newer version became current meanwhile (the row lock orders us with the upload).
    return await db.$transaction(async (tx) => {
      if (!(await isCurrent(tx))) return supersede(tx);
      // Carry-over (spec 005) from the latest earlier extracted version. Reviews take the document lock that
      // isCurrent holds, so every review of the base version committed before now is included.
      const base = await tx.documentVersion.findFirst({
        where: { documentId: version.document_id, status: "extracted", versionNo: { lt: version.version_no } },
        orderBy: { versionNo: "desc" },
        select: {
          values: {
            select: {
              id: true,
              fieldKey: true,
              value: true,
              evidence: true,
              reviews: { select: { id: true, action: true, correctedValue: true, note: true }, orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      });
      const baseValues = base?.values.map(({ reviews: [latestReview], ...v }) => ({ ...v, latestReview: latestReview ?? null })) ?? [];
      const links = carryOver(baseValues, values, parsedText);
      const created = await tx.extractedValue.createManyAndReturn({
        data: values.map((v, i) => ({ ...v, versionId, reviewStatus: links[i]!.reviewStatus, previousValueId: links[i]!.previousValueId })),
        skipDuplicates: true, // ON CONFLICT (version_id, field_key) DO NOTHING
        select: { id: true, fieldKey: true },
      });
      // Only for values this attempt inserted: a reclaimed attempt that committed first carried its own.
      const createdIds = new Map(created.map((v) => [v.fieldKey, v.id]));
      await tx.review.createMany({
        data: links.flatMap(({ carriedReview }, i) => {
          const valueId = createdIds.get(values[i]!.fieldKey);
          return carriedReview && valueId ? [{ ...carriedReview, valueId }] : [];
        }),
      });
      await tx.documentVersion.update({ where: { id: versionId }, data: { status: "extracted", leaseUntil: null } });
      await tx.extractionRun.update({
        where: { id: run.id },
        data: { outcome: "succeeded", finishedAt: new Date(), tokensIn: response.tokensIn, tokensOut: response.tokensOut },
      });
      console.log(`version ${versionId}: extracted ${values.length} values`);
      return "extracted" as const;
    });
  } catch (err) {
    // 7. A failure is a state: visible on the version and the run, retried only by a user action.
    const error = `${err instanceof ExtractionError ? err.code : "unexpected_error"}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`version ${versionId}: extraction failed`, err);
    // Only while still extracting: a version superseded meanwhile stays superseded.
    await db.documentVersion.updateMany({ where: { id: versionId, status: "extracting" }, data: { status: "failed", error, leaseUntil: null } });
    await db.extractionRun.update({ where: { id: run.id }, data: { outcome: "failed", error, finishedAt: new Date() } });
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}
