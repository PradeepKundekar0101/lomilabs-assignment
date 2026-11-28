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

/** Why a new version of an existing document was refused. */
export type VersionRejection = "document_not_found" | "identical_to_current";

export interface RetryDeps {
  db: Pick<PrismaClient, "$queryRaw" | "document">;
  enqueue: (versionId: string) => Promise<void>;
}

export type RetryResult = { versionId: string } | "not_found" | "not_failed";
