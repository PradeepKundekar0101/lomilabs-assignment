import type { DocumentListItem, DocumentType, Value, VersionStatus } from '@lomi/shared'

/** Extraction is still running, so its data will change. */
export const isInFlight = (status: VersionStatus | null | undefined) => status === 'queued' || status === 'extracting'

export const TYPE_LABELS: Record<DocumentType, string> = { invoice: 'Invoice', lease: 'Lease', market_report: 'Market report' }

/** `due_date` reads "Due date". */
export const fieldLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replaceAll('_', ' ')

const norm = (s: string | null) => s?.replace(/\s+/g, ' ').trim() ?? null

/**
 * The value differs from the previous version's (whitespace-normalised, as carry-over compares), or carry-over
 * refused the previous review because the evidence moved. An identical, never-reviewed value is not a change.
 */
export const isChanged = ({ previous, value, reviewStatus }: Value) =>
  !!previous && (norm(previous.value) !== norm(value) || (reviewStatus === 'pending' && previous.latestReview !== null))

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "What needs me?": e.g. "2 changed since v1 · 1 gap · 9 carried over". */
export function reviewSummary(values: Value[]): string {
  const pending = values.filter((v) => v.reviewStatus === 'pending')
  const changed = pending.filter(isChanged)
  const gaps = pending.filter((v) => v.value === null && !isChanged(v))
  const toReview = pending.length - changed.length - gaps.length
  const carried = values.filter((v) => v.reviewStatus === 'carried_over').length
  const parts = [
    changed.length && `${changed.length} changed since v${changed[0]!.previous!.versionNo}`,
    toReview && `${toReview} to review`,
    gaps.length && count(gaps.length, 'gap'),
    pending.length === 0 && 'Nothing needs review',
    carried && `${carried} carried over`,
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Failed first, then documents in flight or with values to review, then the rest; the API's order (newest first) within each. */
export function sortForTriage(docs: DocumentListItem[]): DocumentListItem[] {
  const rank = (d: DocumentListItem) => (d.status === 'failed' ? 0 : isInFlight(d.status) || d.pending > 0 ? 1 : 2)
  return docs.toSorted((a, b) => rank(a) - rank(b))
}
