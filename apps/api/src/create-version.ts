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
  versionNo: number;
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

/** A new version of an existing document was refused, and no row was written. */
export class VersionRejectedError extends Error {
  constructor(readonly reason: "document_not_found" | "identical_to_current") {
    super(reason);
  }
}

const PDF_MIME = "application/pdf";

/**
 * Stores a validated PDF as a new queued, current version of `target`. A previous version keeps its status:
 * one still being extracted supersedes itself at commit, and an extracted one is the base for carry-over (spec 005).
 */
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
    let documentId: string;
    if ("documentId" in target) {
      // The lock reviews and the worker's commit take: concurrent uploads of one document queue here, so the
      // max below is never stale, and a review or carry-over never interleaves with the new version.
      const [doc] = await tx.$queryRaw<{ id: string; current_sha256: string | null }[]>`
        SELECT d.id, v.sha256 AS current_sha256
        FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.id = ${target.documentId}
        FOR UPDATE OF d`;
      if (!doc) throw new VersionRejectedError("document_not_found");
      if (doc.current_sha256 === sha256) throw new VersionRejectedError("identical_to_current");
      documentId = doc.id;
    } else {
      ({ id: documentId } = await tx.document.create({ data: { id: target.id, type: target.type, title: target.title }, select: { id: true } }));
    }
    const { _max } = await tx.documentVersion.aggregate({ where: { documentId }, _max: { versionNo: true } });
    const version = await tx.documentVersion.create({
      data: {
        documentId,
        versionNo: (_max.versionNo ?? 0) + 1,
        status: "queued",
        storageKey,
        sha256,
        sizeBytes: bytes.length,
        mimeType: PDF_MIME,
      },
      select: { id: true, versionNo: true, status: true },
    });
    await tx.document.update({ where: { id: documentId }, data: { currentVersionId: version.id } });
    return { documentId, versionId: version.id, versionNo: version.versionNo, status: version.status };
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
