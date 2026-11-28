import type { RetryDeps, RetryResult } from "../types/versions.js";

/** Queues a document's failed current version for a fresh set of attempts (spec 007). */
export async function retryDocument(deps: RetryDeps, documentId: string): Promise<RetryResult> {
  // One guarded statement: concurrent retries requeue once, and a version that is not failed is left alone.
  const [version] = await deps.db.$queryRaw<{ id: string }[]>`
    UPDATE document_versions v
    SET status = 'queued', error = null, attempts = 0, lease_until = null, updated_at = now()
    FROM documents d
    WHERE d.id = ${documentId} AND v.id = d.current_version_id AND v.status = 'failed'
    RETURNING v.id`;
  if (!version) {
    const exists = await deps.db.document.findUnique({ where: { id: documentId }, select: { id: true } });
    return exists ? "not_failed" : "not_found";
  }
  // As in createVersion: the queued row is the source of truth, and the reconciler enqueues it if this fails.
  try {
    await deps.enqueue(version.id);
  } catch (err) {
    console.error(`retry: enqueue failed for version ${version.id}; row stays queued`, err);
  }
  return { versionId: version.id };
}
