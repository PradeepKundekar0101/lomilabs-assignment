import type { DocumentView, Review, Value } from '@lomi/shared'
import { http, HttpResponse } from 'msw'

const at = '2026-11-27T10:00:00.000Z'
export const approve = (note: string | null = null): Review => ({ action: 'approve', correctedValue: null, note, createdAt: at })
export const correct = (correctedValue: string, note: string | null = null): Review => ({ action: 'correct', correctedValue, note, createdAt: at })

export function value(fieldKey: string, v: Partial<Value> = {}): Value {
  const base: Value = {
    id: `val-${fieldKey}`,
    fieldKey,
    value: `${fieldKey} value`,
    evidence: null,
    evidenceStart: null,
    evidenceEnd: null,
    gapReason: null,
    reviewStatus: 'pending',
    effectiveValue: null,
    latestReview: null,
    previous: null,
  }
  const merged = { ...base, ...v }
  return { ...merged, effectiveValue: v.effectiveValue ?? (merged.latestReview?.action === 'correct' ? merged.latestReview.correctedValue : merged.value) }
}

const text = 'Due Date: 2025-11-13\nTotal Due: $6,126.45\nInvoice Number: INV-2025-0847\nIssue Date: 2025-09-14'

/** The revised invoice after re-extraction, in API order: 2 changed, a gap, 2 carried over. */
export function invoiceV2(): DocumentView {
  const version = { id: 'ver-2', versionNo: 2, status: 'extracted' as const, error: null, attempts: 1, createdAt: at }
  return {
    id: 'doc-1',
    title: 'invoice-001.v2.pdf',
    type: 'invoice',
    createdAt: at,
    currentVersion: version,
    version: { ...version, parsedText: text },
    values: [
      value('due_date', {
        value: '2025-11-13',
        evidence: 'Due Date: 2025-11-13',
        evidenceStart: 0,
        evidenceEnd: 20,
        previous: { versionNo: 1, value: '2025-10-14', effectiveValue: '2025-10-14', latestReview: approve('checked') },
      }),
      value('total_amount', {
        value: '$6,126.45',
        evidence: 'Total Due: $6,126.45',
        previous: { versionNo: 1, value: '$5,230.29', effectiveValue: '5230.29', latestReview: correct('5230.29', 'plain number') },
      }),
      value('vendor_name', { value: null, gapReason: 'The vendor is not named on the page' }),
      value('invoice_number', {
        value: 'INV-2025-0847',
        reviewStatus: 'carried_over',
        latestReview: approve(),
        previous: { versionNo: 1, value: 'INV-2025-0847', effectiveValue: 'INV-2025-0847', latestReview: approve() },
      }),
      value('issue_date', {
        value: '2025-09-14',
        reviewStatus: 'carried_over',
        latestReview: approve(),
        previous: { versionNo: 1, value: '2025-09-14', effectiveValue: '2025-09-14', latestReview: approve() },
      }),
    ],
  }
}

/** GET handlers for a document and its progress, serving whatever `get()` returns at the time; counts the reads. */
export function documentHandlers(get: () => DocumentView) {
  const reads = { document: 0 }
  const handlers = [
    http.get('/api/documents/:id', () => {
      reads.document++
      return HttpResponse.json(get())
    }),
    http.get('/api/documents/:id/progress', () => {
      const { currentVersion, values } = get()
      const pending = values.filter((v) => v.reviewStatus === 'pending').length
      return HttpResponse.json({
        versionNo: currentVersion?.versionNo ?? null,
        status: currentVersion?.status ?? null,
        total: values.length,
        pending,
        approved: 0,
        corrected: 0,
        carriedOver: 0,
        gaps: 0,
      })
    }),
  ]
  return { reads, handlers }
}
