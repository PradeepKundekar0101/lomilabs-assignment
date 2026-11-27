import {
  buildPrompt,
  ExtractionError,
  extractPdfText,
  parseLlmOutput,
  validateEvidence,
  type ExpectedFields,
  type Llm,
} from "@lomi/core";
import type { PrismaClient } from "@lomi/db";

export interface ExtractDeps {
  db: PrismaClient;
  getObject: (key: string) => Promise<Uint8Array>;
  llm: Llm;
  model: string;
  fields: ExpectedFields;
}

export type ExtractOutcome = "not_claimable" | "superseded" | "extracted" | "failed";

interface ClaimedVersion {
  id: string;
  document_id: string;
  storage_key: string;
  attempts: number;
}

/** Runs one extraction attempt for a version (spec 003). Never throws for an extraction failure. */
export async function processVersion(deps: ExtractDeps, versionId: string): Promise<ExtractOutcome> {
  const { db } = deps;

  // 1. Claim: only a queued version, or one whose previous attempt's lease ran out.
  const [version] = await db.$queryRaw<ClaimedVersion[]>`
    UPDATE document_versions
    SET status = 'extracting', lease_until = now() + interval '5 minutes',
        attempts = attempts + 1, error = null, updated_at = now()
    WHERE id = ${versionId}::uuid
      AND (status = 'queued' OR (status = 'extracting' AND lease_until < now()))
    RETURNING id, document_id, storage_key, attempts`;
  if (!version) {
    console.log(`version ${versionId}: not claimable`);
    return "not_claimable";
  }
  const run = await db.extractionRun.create({
    data: { versionId, attempt: version.attempts, model: deps.model },
    select: { id: true },
  });

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
      await tx.extractedValue.createMany({
        data: values.map((v) => ({ ...v, versionId, reviewStatus: "pending" as const })),
        skipDuplicates: true, // ON CONFLICT (version_id, field_key) DO NOTHING
      });
      // HOOK: carry-over from previous extracted version goes here (step 10, spec 005)
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
  }
}
