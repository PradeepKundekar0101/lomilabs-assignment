import { createHash } from "node:crypto";
import type { DocumentType, PrismaClient, VersionStatus } from "@lomi/db";

export interface CreateVersionDeps {
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  db: Pick<PrismaClient, "$transaction">;
  enqueue: (versionId: string) => Promise<void>;
}

export interface CreateVersionResult {
  documentId: string;
  versionId: string;
  status: VersionStatus;
}

/** Where a new version goes: an existing document, or a new one (with a chosen id, or a generated uuid). */
export type VersionTarget = { documentId: string } | { id?: string; type: DocumentType; title: string };

/** Object storage did not take the file, so nothing was written. */
export class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super("object storage unavailable", { cause });
  }
}

const PDF_MIME = "application/pdf";

/** Stores a validated PDF as a new queued version of `target`, superseding an existing document's current version. */
export async function createVersion(deps: CreateVersionDeps, target: VersionTarget, file: File): Promise<CreateVersionResult> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Content-addressed, so re-uploading identical bytes rewrites the same object.
  const storageKey = `pdfs/${sha256}.pdf`;

  // Object first: a row must never point at an object that does not exist.
  try {
    await deps.putObject(storageKey, bytes, PDF_MIME);
  } catch (err) {
    throw new StorageUnavailableError(err);
  }

  const result = await deps.db.$transaction(async (tx) => {
    const docFields = { id: true, currentVersionId: true } as const;
    const doc =
      "documentId" in target
        ? await tx.document.findUniqueOrThrow({ where: { id: target.documentId }, select: docFields })
        : await tx.document.create({ data: { id: target.id, type: target.type, title: target.title }, select: docFields });
    const { _max } = await tx.documentVersion.aggregate({ where: { documentId: doc.id }, _max: { versionNo: true } });
    // shortcut: concurrent uploads to one document race on (document_id, version_no) and the loser fails; spec 005 adds the retry.
    const version = await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: (_max.versionNo ?? 0) + 1,
        status: "queued",
        storageKey,
        sha256,
        sizeBytes: bytes.length,
        mimeType: PDF_MIME,
      },
      select: { id: true, status: true },
    });
    if (doc.currentVersionId) {
      await tx.documentVersion.update({ where: { id: doc.currentVersionId }, data: { status: "superseded" } });
    }
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { documentId: doc.id, versionId: version.id, status: version.status };
  });

  // The committed row (status queued) is the source of truth and the reconciler re-enqueues it;
  // a failed enqueue must not turn a saved upload into an error the client retries into a duplicate.
  try {
    await deps.enqueue(result.versionId);
  } catch (err) {
    console.error(`createVersion: enqueue failed for version ${result.versionId}; row stays queued`, err);
  }
  return result;
}
