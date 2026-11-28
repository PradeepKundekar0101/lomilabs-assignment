import {
  DocumentListSchema,
  DocumentViewSchema,
  ProgressSchema,
  RetryResultSchema,
  UploadResultSchema,
  ValueSchema,
  type DocumentListItem,
  type DocumentType,
  type ReviewInput,
} from '@lomi/shared'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { isInFlight } from '@/lib/review'
import { api, ApiError } from './client'

export const queryKeys = {
  documents: ['documents'] as const,
  document: (id: string, versionNo?: number) => ['document', id, versionNo ?? 'current'] as const,
  /** A prefix of every version's key: what invalidation uses. */
  anyVersion: (id: string) => ['document', id] as const,
  progress: (id: string) => ['progress', id] as const,
}

const POLL_MS = 2000

function invalidate(client: QueryClient, documentId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.documents }),
    client.invalidateQueries({ queryKey: queryKeys.anyVersion(documentId) }),
    client.invalidateQueries({ queryKey: queryKeys.progress(documentId) }),
  ])
}

const post = (body?: BodyInit) => ({ method: 'POST', body })

export function useDocuments() {
  return useQuery({
    queryKey: queryKeys.documents,
    queryFn: () => api('/documents', DocumentListSchema),
    refetchInterval: (q) => (q.state.data?.some((d) => isInFlight(d.status)) ? POLL_MS : false),
  })
}

/** The current version, or version `versionNo`. */
export function useDocument(id: string, versionNo?: number) {
  return useQuery({
    queryKey: queryKeys.document(id, versionNo),
    queryFn: () => api(versionNo === undefined ? `/documents/${id}` : `/documents/${id}/versions/${versionNo}`, DocumentViewSchema),
    // The current version's status: an older version never changes, but a newer one may be on its way.
    refetchInterval: (q) => (isInFlight(q.state.data?.currentVersion?.status) ? POLL_MS : false),
  })
}

export function useProgress(id: string) {
  return useQuery({
    queryKey: queryKeys.progress(id),
    queryFn: () => api(`/documents/${id}/progress`, ProgressSchema),
    refetchInterval: (q) => (isInFlight(q.state.data?.status) ? POLL_MS : false),
  })
}

export function useUploadDocument() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ type, file }: { type: DocumentType; file: File }) => {
      const form = new FormData()
      form.set('type', type)
      form.set('file', file)
      return api('/documents', UploadResultSchema, post(form))
    },
    onSuccess: (doc, { type, file }) => {
      // Show the row at once, as the API will list it; the refetch below replaces it.
      const row: DocumentListItem = { id: doc.id, title: file.name, type, versionNo: doc.versionNo, status: doc.status, error: null, total: 0, pending: 0 }
      client.setQueryData<DocumentListItem[]>(queryKeys.documents, (docs) => [row, ...(docs ?? [])])
      return invalidate(client, doc.id)
    },
  })
}

export function useUploadVersion(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      return api(`/documents/${id}/versions`, UploadResultSchema, post(form))
    },
    onSuccess: () => invalidate(client, id),
  })
}

export function useReview() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ valueId, input }: { valueId: string; documentId: string; input: ReviewInput }) =>
      api(`/values/${valueId}/review`, ValueSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_value, { documentId }) => invalidate(client, documentId),
    onError: (err, { documentId }) => {
      if (err instanceof ApiError && err.status === 409 && err.error === 'stale_version') {
        toast.info('A newer version arrived, so this review was not saved. Showing the new version.')
        return invalidate(client, documentId)
      }
      toast.error(`Review not saved: ${err.message}`)
    },
  })
}

export function useRetry(id: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => api(`/documents/${id}/retry`, RetryResultSchema, post()),
    onSuccess: () => invalidate(client, id),
    onError: (err) => toast.error(`Retry failed: ${err.message}`),
  })
}
