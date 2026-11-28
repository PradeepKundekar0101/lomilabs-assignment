import type { ExpectedFields } from "@lomi/core";
import type { PrismaClient } from "@lomi/db";
import type { DocumentListItem, Progress } from "@lomi/shared";
import { sortForReview, toValueView, valueSelect } from "./value-view.js";

const versionSelect = { id: true, versionNo: true, status: true, error: true, attempts: true, createdAt: true } as const;

/** Every document, newest first, with its current version and that version's review counts, in one query. */
export async function listDocuments(db: PrismaClient): Promise<DocumentListItem[]> {
  // shortcut: unpaginated, add cursor pagination when the list gets long.
  return db.$queryRaw<DocumentListItem[]>`
    SELECT d.id, d.title, d.type::text AS type, v.version_no AS "versionNo", v.status::text AS status, v.error,
      count(ev.id)::int AS total,
      count(*) FILTER (WHERE ev.review_status = 'pending')::int AS pending
    FROM documents d
    LEFT JOIN document_versions v ON v.id = d.current_version_id
    LEFT JOIN extracted_values ev ON ev.version_id = v.id
    GROUP BY d.id, v.id
    ORDER BY d.created_at DESC`;
}

/** A document with one version's values: the current version, or version `versionNo`. Null when either is missing. */
export async function getDocumentView(db: PrismaClient, fields: ExpectedFields, documentId: string, versionNo?: number) {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, title: true, type: true, createdAt: true, currentVersion: { select: versionSelect } },
  });
  if (!doc) return null;
  const no = versionNo ?? doc.currentVersion?.versionNo;
  // Only `version` carries the parsed text its evidence offsets point into, so the current version's is not sent twice.
  const version =
    no === undefined
      ? null
      : await db.documentVersion.findUnique({ where: { documentId_versionNo: { documentId, versionNo: no } }, select: { ...versionSelect, parsedText: true } });
  if (versionNo !== undefined && !version) return null;
  const values = version ? await db.extractedValue.findMany({ where: { versionId: version.id }, select: valueSelect }) : [];
  return { ...doc, version, values: sortForReview(values.map(toValueView), fields[doc.type]) };
}

/** Review counts for the document's current version, in one query. Null for an unknown document. */
export async function getDocumentProgress(db: PrismaClient, documentId: string): Promise<Progress | null> {
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
