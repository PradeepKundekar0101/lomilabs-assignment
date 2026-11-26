import { createHash } from "node:crypto";
import type { DocumentType, PrismaClient } from "@lomi/db";

export interface UploadDeps {
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  db: Pick<PrismaClient, "$transaction">;
  enqueue: (versionId: string) => Promise<void>;
}

export interface UploadInput {
  type: DocumentType;
  title: string;
  pdf: Buffer;
}

export interface UploadResult {
  documentId: string;
  versionId: string;
}

const PDF_MIME = "application/pdf";

export async function uploadDocument(deps: UploadDeps, input: UploadInput): Promise<UploadResult> {
  const sha256 = createHash("sha256").update(input.pdf).digest("hex");
  // Content-addressed, so re-uploading identical bytes rewrites the same object.
  const storageKey = `pdfs/${sha256}.pdf`;

  // Object first: a row must never point at an object that does not exist.
  await deps.putObject(storageKey, input.pdf, PDF_MIME);

  const result = await deps.db.$transaction(async (tx) => {
    const doc = await tx.document.create({ data: { type: input.type, title: input.title } });
    const version = await tx.documentVersion.create({
      data: { documentId: doc.id, versionNo: 1, storageKey, sha256, sizeBytes: input.pdf.length, mimeType: PDF_MIME },
    });
    await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
    return { documentId: doc.id, versionId: version.id };
  });

  // The committed row (status queued) is the source of truth; a failed enqueue must not turn a
  // saved upload into an error the client retries into a duplicate document.
  try {
    await deps.enqueue(result.versionId);
  } catch (err) {
    console.error(`upload: enqueue failed for version ${result.versionId}; row stays queued`, err);
  }
  return result;
}
