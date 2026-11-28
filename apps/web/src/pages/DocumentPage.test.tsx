import type { DocumentView } from '@lomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approve, correct, documentHandlers, invoiceV2, value } from '@/test/fixtures'
import { renderAt } from '@/test/render'
import { server } from '@/test/server'

/** The card of the value whose field reads `field`, once it has rendered. */
async function card(field: string) {
  return (await screen.findByRole('button', { name: field })).closest<HTMLElement>('[data-slot="card"]')!
}

const badges = () => [...screen.getByRole('region', { name: 'Values' }).querySelectorAll('[data-slot="badge"]')]

describe('document page', () => {
  afterEach(() => void vi.useRealTimers())

  it('renders pending values before carried-over ones, and a gap with its reason', async () => {
    server.use(...documentHandlers(invoiceV2).handlers)
    renderAt('/documents/doc-1')

    await card('Due date')
    expect(badges().map((b) => b.textContent)).toEqual(['Pending', 'Pending', 'Pending', 'Carried over from v1', 'Carried over from v1'])
    const gap = await card('Vendor name')
    expect(within(gap).getByText('No value')).toBeVisible()
    expect(within(gap).getByText('Why no value: The vendor is not named on the page')).toBeVisible()
    expect(screen.getByText('2 changed since v1 · 1 gap · 2 carried over')).toBeVisible()
  })

  it('blocks a correction with an empty value, and an approve updates the badge', async () => {
    let doc = invoiceV2()
    const posts: unknown[] = []
    server.use(
      ...documentHandlers(() => doc).handlers,
      http.post('/api/values/:id/review', async ({ request, params }) => {
        posts.push(await request.json())
        const approved = value('due_date', { ...doc.values.find((v) => v.id === params.id), reviewStatus: 'approved', latestReview: approve() })
        doc = { ...doc, values: doc.values.map((v) => (v.id === approved.id ? approved : v)) }
        return HttpResponse.json(approved)
      }),
    )
    const user = userEvent.setup()
    renderAt('/documents/doc-1')
    const due = await card('Due date')

    await user.click(within(due).getByRole('button', { name: 'Correct' }))
    await user.clear(within(due).getByLabelText('Correct value'))
    await user.click(within(due).getByRole('button', { name: 'Save correction' }))
    expect(within(due).getByText('Enter the correct value.')).toBeVisible()
    expect(within(due).getByLabelText('Correct value')).toHaveAttribute('aria-invalid', 'true')
    expect(posts).toEqual([])

    await user.click(within(due).getByRole('button', { name: 'Cancel' }))
    await user.click(within(due).getByRole('button', { name: 'Approve' }))
    expect(await within(due).findByText('Approved', { selector: '[data-slot="badge"]' })).toBeVisible()
    expect(posts).toEqual([{ action: 'approve' }])
  })

  it('polls while the version is extracting and stops once it is extracted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const extracted = invoiceV2()
    const extracting: DocumentView = {
      ...extracted,
      currentVersion: { ...extracted.currentVersion!, status: 'extracting' },
      version: { ...extracted.version!, status: 'extracting', parsedText: null },
      values: [],
    }
    const api = documentHandlers(() => (api.reads.document === 1 ? extracting : extracted))
    server.use(...api.handlers)
    renderAt('/documents/doc-1')

    expect(await screen.findByText('Extracting')).toBeVisible()
    expect(api.reads.document).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await screen.findByText('Extracted')).toBeVisible()
    expect(api.reads.document).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.reads.document).toBe(2)
  })

  it("shows a changed value's previous version with its review, and none for carried-over values", async () => {
    const doc = invoiceV2()
    // A carried-over correction: the model's value is still struck through.
    const prev = { versionNo: 1, value: 'inv 847', effectiveValue: 'INV-2025-0847', latestReview: correct('INV-2025-0847') }
    doc.values[3] = value('invoice_number', { ...doc.values[3], value: 'inv 847', latestReview: prev.latestReview, previous: prev })
    server.use(...documentHandlers(() => doc).handlers)
    renderAt('/documents/doc-1')

    const due = await card('Due date')
    expect(within(due).getByText('Previous (v1)')).toBeVisible()
    expect(within(due).getByText('2025-10-14')).toBeVisible()
    expect(within(due).getByText(/^Approved/)).toHaveTextContent('Approved · Note: checked')

    const total = await card('Total amount')
    expect(within(total).getByText('Previous (v1)')).toBeVisible()
    expect(within(total).getByText('$5,230.29').tagName).toBe('S')
    expect(within(total).getByText(/^Corrected to/)).toHaveTextContent('Corrected to "5230.29" · Note: plain number')

    const carried = await card('Invoice number')
    expect(within(carried).queryByText(/Previous/)).toBeNull()
    expect(within(carried).getByText('inv 847').tagName).toBe('S')
    expect(within(await card('Vendor name')).queryByText(/Previous/)).toBeNull()
  })

  it('shows a toast and refetches when a review gets 409 stale_version', async () => {
    const api = documentHandlers(invoiceV2)
    server.use(
      ...api.handlers,
      http.post('/api/values/:id/review', () => HttpResponse.json({ error: 'stale_version', currentVersionNo: 3 }, { status: 409 })),
    )
    const user = userEvent.setup()
    renderAt('/documents/doc-1')
    const due = await card('Due date')
    const before = api.reads.document

    await user.click(within(due).getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('A newer version arrived, so this review was not saved. Showing the new version.')).toBeVisible()
    await waitFor(() => expect(api.reads.document).toBeGreaterThan(before))
  })

  it("marks the selected value's evidence in the document text", async () => {
    const doc = invoiceV2()
    doc.values[1] = { ...doc.values[1]!, evidenceStart: 21, evidenceEnd: 41 }
    server.use(...documentHandlers(() => doc).handlers)
    const user = userEvent.setup()
    renderAt('/documents/doc-1')

    const text = await screen.findByRole('region', { name: 'Document text' })
    expect(within(text).getByText('Due Date: 2025-11-13').tagName).toBe('MARK')
    await user.click(screen.getByRole('button', { name: 'Total amount' }))
    expect(within(text).getByText('Total Due: $6,126.45').tagName).toBe('MARK')
    expect(screen.getByRole('button', { name: 'Total amount' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows an older version read-only', async () => {
    const v1 = invoiceV2()
    v1.version = { ...v1.version!, id: 'ver-1', versionNo: 1, status: 'superseded' }
    server.use(
      ...documentHandlers(invoiceV2).handlers,
      http.get('/api/documents/:id/versions/:n', () => HttpResponse.json(v1)),
    )
    renderAt('/documents/doc-1?v=1')

    expect(await screen.findByText('Viewing v1 (read-only)')).toBeVisible()
    await card('Due date')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull()
  })
})
