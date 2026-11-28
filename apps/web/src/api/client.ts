import { ApiErrorBodySchema } from '@lomi/shared'
import type { z } from 'zod'

// Same-origin by default: nginx (and the Vite dev server) proxy /api to the api with the prefix stripped.
const BASE_URL = import.meta.env.VITE_API_URL ?? '/api'

// Error codes the API sends without a sentence of their own.
const MESSAGES: Record<string, string> = {
  identical_to_current: 'This file is identical to the current version.',
  stale_version: 'A newer version arrived, so this review was not saved. Showing the new version.',
}

export class ApiError extends Error {
  readonly status: number
  readonly error: string

  constructor(status: number, error: string, message: string) {
    super(message)
    this.status = status
    this.error = error
  }
}

/** Fetches `path` and parses the JSON body with `schema`; a non-2xx response throws an ApiError. */
export async function api<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init)
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(body)
    const error = parsed.success ? parsed.data.error : `http_${res.status}`
    // The API's own messages start lowercase ("file is not a PDF"); they are shown as sentences.
    const message = MESSAGES[error] ?? (parsed.success ? error.charAt(0).toUpperCase() + error.slice(1) : `Request failed (${res.status})`)
    throw new ApiError(res.status, error, message)
  }
  return schema.parse(body)
}
