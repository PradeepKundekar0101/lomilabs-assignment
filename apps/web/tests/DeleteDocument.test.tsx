import type { DocumentListItem } from '@lomi/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { documentHandlers, invoiceV2 } from './fixtures'
import { renderAt } from './render'
import { server } from './server'

const row = (id: string, title: string): DocumentListItem => ({ id, title, type: 'invoice', versionNo: 1, status: 'extracted', error: null, total: 5, pending: 0 })

/** A list API holding doc-1 and doc-2; a DELETE removes the row, or answers `fail` when given. Records the deleted ids. */
function listApi(fail?: { status: number; error: string }) {
  let rows = [row('doc-1', 'invoice-001.v2.pdf'), row('doc-2', 'lease.pdf')]
  const deleted: string[] = []
  server.use(
    http.get('/api/documents', () => HttpResponse.json(rows)),
    http.delete('/api/documents/:id', ({ params }) => {
      if (fail) return HttpResponse.json({ error: fail.error }, { status: fail.status })
      deleted.push(String(params.id))
      rows = rows.filter((r) => r.id !== params.id)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return deleted
}

describe('deleting a document (spec 011)', () => {
  it('asks first from the list, then removes the row', async () => {
    const deleted = listApi()
    const user = userEvent.setup()
    renderAt('/')

    await user.click(await screen.findByRole('button', { name: 'Delete lease.pdf' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete document?' })
    expect(within(dialog).getByText('lease.pdf')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleted).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Delete lease.pdf' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'lease.pdf' })).toBeNull())
    expect(deleted).toEqual(['doc-2'])
    expect(screen.getByRole('link', { name: 'invoice-001.v2.pdf' })).toBeVisible()
    expect(await screen.findByText('lease.pdf deleted')).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('goes back to the list after deleting from the document page', async () => {
    const deleted = listApi()
    server.use(...documentHandlers(invoiceV2).handlers)
    const user = userEvent.setup()
    renderAt('/documents/doc-1')

    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('heading', { name: 'Documents' })).toBeVisible()
    expect(deleted).toEqual(['doc-1'])
    expect(await screen.findByRole('link', { name: 'lease.pdf' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'invoice-001.v2.pdf' })).toBeNull()
  })

  it("shows a failed delete's message in the dialog, which stays open", async () => {
    listApi({ status: 404, error: 'document not found' })
    const user = userEvent.setup()
    renderAt('/')

    await user.click(await screen.findByRole('button', { name: 'Delete lease.pdf' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByText('Document not found')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('link', { name: 'lease.pdf' })).toBeVisible()
  })
})
