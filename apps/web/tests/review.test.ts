import type { DocumentListItem } from '@lomi/shared'
import { describe, expect, it } from 'vitest'
import { approve, invoiceV2, value } from './fixtures'
import { isChanged, listSummary, reviewSummary, sortForTriage } from '@/lib/review'

const doc = (id: string, d: Partial<DocumentListItem>): DocumentListItem => ({
  id, title: id, type: 'invoice', versionNo: 1, status: 'extracted', error: null, total: 5, pending: 0, ...d,
})

describe('isChanged', () => {
  const prev = (v: string | null, latestReview = approve()) => ({ versionNo: 1, value: v, effectiveValue: v, latestReview })

  it('is a different value, or a pending value whose previous review did not carry over', () => {
    expect(isChanged(value('a', { value: 'new', previous: prev('old') }))).toBe(true)
    expect(isChanged(value('a', { value: 'same', previous: prev('same') }))).toBe(true)
    expect(isChanged(value('a', { value: 'new', reviewStatus: 'approved', previous: prev('old') }))).toBe(true)
  })

  it('is not an unchanged value, never-reviewed or carried over, whitespace aside, nor one with no previous version', () => {
    expect(isChanged(value('a', { value: 'same  value', previous: { ...prev('same value'), latestReview: null } }))).toBe(false)
    expect(isChanged(value('a', { value: 'same', reviewStatus: 'carried_over', previous: prev('same') }))).toBe(false)
    expect(isChanged(value('a', { value: 'new' }))).toBe(false)
  })
})

describe('reviewSummary', () => {
  it('says what needs review, leaving out zero counts', () => {
    expect(reviewSummary(invoiceV2().values)).toBe('2 changed since v1 · 1 gap · 2 carried over')
    expect(reviewSummary([value('a'), value('b'), value('c', { value: null }), value('d', { value: null })])).toBe('2 to review · 2 gaps')
    expect(reviewSummary([value('a', { reviewStatus: 'approved' }), value('b', { reviewStatus: 'carried_over' })])).toBe(
      'Nothing needs review · 1 carried over',
    )
  })
})

describe('sortForTriage', () => {
  it('puts failed documents first, then those in flight or with pending values, keeping the order within each', () => {
    const docs = [doc('queued', { status: 'queued', total: 0 }), doc('done', {}), doc('pending-1', { pending: 2 }), doc('failed', { status: 'failed' }), doc('extracting', { status: 'extracting', total: 0 }), doc('pending-2', { pending: 1 })]
    expect(sortForTriage(docs).map((d) => d.id)).toEqual(['failed', 'queued', 'pending-1', 'extracting', 'pending-2', 'done'])
  })
})

describe('listSummary', () => {
  it('counts pending values and the documents holding them, then failed and in-flight documents', () => {
    const docs = [doc('a', { pending: 3 }), doc('b', { pending: 1 }), doc('c', {}), doc('d', { status: 'failed', total: 0 }), doc('e', { status: 'queued', total: 0 }), doc('f', { status: 'extracting', total: 0 })]
    expect(listSummary(docs)).toBe('4 values to review in 2 documents · 1 failed · 2 in progress')
    expect(listSummary([doc('a', { pending: 1 })])).toBe('1 value to review in 1 document')
  })

  it('says when nothing is pending, and when there are no documents', () => {
    expect(listSummary([doc('a', {}), doc('b', { status: 'failed', total: 0 })])).toBe('Nothing to review · 1 failed')
    expect(listSummary([])).toBe('No documents yet')
  })
})
