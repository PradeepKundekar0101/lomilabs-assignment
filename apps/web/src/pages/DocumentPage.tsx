import type { DocumentView, Value } from '@lomi/shared'
import { ArrowLeft, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ApiError } from '@/api/client'
import { useDocument, useProgress, useRetry } from '@/api/hooks'
import { StatusBadge } from '@/components/StatusBadge'
import { UploadDialog } from '@/components/UploadDialog'
import { ValueCard } from '@/components/ValueCard'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { isInFlight, reviewSummary, TYPE_LABELS } from '@/lib/review'

/** The version's parsed text, with the selected value's evidence marked and scrolled into view. */
function EvidenceText({ text, value }: { text: string; value: Value | undefined }) {
  const mark = useRef<HTMLElement>(null)
  const start = value?.evidenceStart ?? null
  const end = value?.evidenceEnd ?? null
  useEffect(() => {
    // Scrolls only the text panel, so the page stays on the card that was clicked; the mark lands a third of the way down.
    const el = mark.current
    const panel = el?.closest('[data-slot="scroll-area-viewport"]')
    if (!el || !panel) return
    const top = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop
    panel.scrollTo({ top: top - panel.clientHeight / 3, behavior: 'smooth' })
  }, [start, end])

  return (
    <pre className="p-4 font-mono text-sm whitespace-pre-wrap">
      {start === null || end === null ? (
        text
      ) : (
        <>
          {text.slice(0, start)}
          <mark ref={mark} className="rounded-sm bg-yellow-200 px-0.5 text-foreground">
            {text.slice(start, end)}
          </mark>
          {text.slice(end)}
        </>
      )}
    </pre>
  )
}

function ProgressLine({ id }: { id: string }) {
  const { data } = useProgress(id)
  if (!data?.total) return null
  const done = data.total - data.pending
  return (
    <div className="flex items-center gap-3">
      <Progress value={(done / data.total) * 100} className="max-w-48" aria-label="Review progress" />
      <span className="text-sm whitespace-nowrap text-muted-foreground">
        {data.pending} pending · {done} done
      </span>
    </div>
  )
}

function Header({ doc, onVersion }: { doc: DocumentView; onVersion: (versionNo: number | undefined) => void }) {
  const retry = useRetry(doc.id)
  const current = doc.currentVersion
  const version = doc.version
  const isCurrent = version?.versionNo === current?.versionNo

  return (
    <Card>
      {/* Stacked on phones, so the upload button does not squeeze the title into a narrow column. */}
      <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
        <CardTitle className="text-xl">{doc.title}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-3">
          {TYPE_LABELS[doc.type]}
          {current && version && (
            <Select value={String(version.versionNo)} onValueChange={(v) => onVersion(Number(v) === current.versionNo ? undefined : Number(v))}>
              <SelectTrigger size="sm" aria-label="Version">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: current.versionNo }, (_, i) => current.versionNo - i).map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    v{n}
                    {n === current.versionNo && ' (current)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <StatusBadge status={version?.status ?? null} error={version?.error} />
        </CardDescription>
        <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:mt-2 max-sm:justify-self-start">
          <UploadDialog documentId={doc.id} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {version?.status === 'extracted' && <p className="font-medium">{reviewSummary(doc.values)}</p>}
        {isInFlight(version?.status) && (
          <p className="text-muted-foreground">
            {version?.status === 'queued' ? 'Queued for extraction' : 'Extracting'}. The values appear here when it finishes.
          </p>
        )}
        {isCurrent && <ProgressLine id={doc.id} />}
        {!isCurrent && version && current && (
          <Alert>
            <AlertTitle>Viewing v{version.versionNo} (read-only)</AlertTitle>
            <AlertDescription>Reviews are made on the current version, v{current.versionNo}.</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => onVersion(undefined)}>
                Go to v{current.versionNo}
              </Button>
            </AlertAction>
          </Alert>
        )}
        {version?.status === 'failed' && (
          <Alert variant="destructive">
            <AlertTitle>Extraction failed</AlertTitle>
            <AlertDescription>{version.error ?? 'No error recorded.'}</AlertDescription>
            {isCurrent && (
              <AlertAction>
                <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
                  <RotateCw aria-hidden />
                  Retry
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function LoadingPage() {
  return (
    <div className="grid gap-6" aria-busy="true" aria-label="Loading document">
      <Skeleton className="h-32 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid gap-4">
          {[1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-40 w-full" />
          ))}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  )
}

export function DocumentPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const versionNo = params.has('v') ? Number(params.get('v')) : undefined
  const { data: doc, error } = useDocument(id, versionNo)
  const [selectedId, setSelectedId] = useState<string>()

  const back = (
    <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" aria-hidden />
      All documents
    </Link>
  )
  if (error) {
    return (
      <div className="grid gap-6">
        {back}
        <Alert variant="destructive">
          <AlertTitle>{error instanceof ApiError && error.status === 404 ? 'Not found' : 'Could not load the document'}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }
  if (!doc) return <LoadingPage />

  const isCurrent = doc.version?.versionNo === doc.currentVersion?.versionNo
  const selected = doc.values.find((v) => v.id === selectedId) ?? doc.values[0]

  return (
    <div className="grid gap-6">
      {back}
      <Header doc={doc} onVersion={(n) => setParams(n === undefined ? {} : { v: String(n) })} />
      {doc.values.length > 0 && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <section aria-label="Values" className="grid gap-4">
            {doc.values.map((value) => (
              <ValueCard
                key={value.id}
                value={value}
                documentId={doc.id}
                readOnly={!isCurrent}
                selected={value.id === selected?.id}
                onSelect={() => setSelectedId(value.id)}
                onReviewed={() => setSelectedId(undefined)}
              />
            ))}
          </section>
          <Card className="py-0 lg:sticky lg:top-6">
            <ScrollArea className="h-[calc(100vh-6rem)]" role="region" aria-label="Document text">
              <EvidenceText text={doc.version?.parsedText ?? ''} value={selected} />
            </ScrollArea>
          </Card>
        </div>
      )}
    </div>
  )
}
