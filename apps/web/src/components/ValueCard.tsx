import type { Review, Value } from '@lomi/shared'
import { Check, Pencil } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { useReview } from '@/api/hooks'
import { DotBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { fieldLabel, isChanged } from '@/lib/review'

function ReviewBadge({ value }: { value: Value }) {
  switch (value.reviewStatus) {
    case 'pending':
      return <DotBadge dot="bg-amber-500">Pending</DotBadge>
    case 'approved':
      return <DotBadge dot="bg-emerald-500">Approved</DotBadge>
    case 'corrected':
      return <DotBadge dot="bg-violet-500">Corrected</DotBadge>
    case 'carried_over':
      return <DotBadge dot="bg-brand">Carried over{value.previous && ` from v${value.previous.versionNo}`}</DotBadge>
  }
}

/** The effective value; a correction (also a carried-over one) shows the model's value struck through before it. */
function ShownValue({ value, effectiveValue, corrected, className }: { value: string | null; effectiveValue: string | null; corrected: boolean; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-primary', className)}>
      {corrected && <s className="text-base font-normal text-muted-foreground">{value ?? 'No value'}</s>}
      <span>{effectiveValue ?? 'No value'}</span>
    </p>
  )
}

function ReviewLine({ review }: { review: Review | null }) {
  if (!review) return <p className="text-sm text-muted-foreground">Not reviewed</p>
  return (
    <p className="text-sm">
      {review.action === 'approve' ? 'Approved' : `Corrected to "${review.correctedValue}"`}
      {review.note && <span className="text-muted-foreground"> · Note: {review.note}</span>}
    </p>
  )
}

function CorrectForm({ value, documentId, onDone, onSaved }: { value: Value; documentId: string; onDone: () => void; onSaved: () => void }) {
  const id = useId()
  const review = useReview()
  const [corrected, setCorrected] = useState(value.effectiveValue ?? '')
  const [note, setNote] = useState('')
  const [blank, setBlank] = useState(false)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!corrected.trim()) return setBlank(true)
    const input = { action: 'correct' as const, correctedValue: corrected.trim(), ...(note.trim() && { note: note.trim() }) }
    review.mutate({ valueId: value.id, documentId, input }, { onSuccess: () => (onDone(), onSaved()) })
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 rounded-xl bg-muted p-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-value`}>Correct value</Label>
        <Input
          id={`${id}-value`}
          className="h-10 bg-card px-3.5"
          value={corrected}
          required
          aria-invalid={blank}
          aria-describedby={blank ? `${id}-error` : undefined}
          onChange={(e) => (setCorrected(e.target.value), setBlank(false))}
        />
        {blank && (
          <p id={`${id}-error`} className="text-sm text-destructive">
            Enter the correct value.
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-note`}>Note (optional)</Label>
        <Textarea id={`${id}-note`} className="bg-card px-3.5" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="lg" className="px-4" disabled={review.isPending}>
          Save correction
        </Button>
        <Button type="button" size="lg" variant="ghost" className="px-4" onClick={onDone} disabled={review.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** One extracted value: what it is, why, what it was, and the review actions when the version is current. */
export function ValueCard({
  value,
  documentId,
  readOnly,
  selected,
  onSelect,
  onReviewed,
}: {
  value: Value
  documentId: string
  readOnly: boolean
  selected: boolean
  onSelect: () => void
  /** After a saved review: the value moves down the list, so the page selects what is now on top. */
  onReviewed: () => void
}) {
  const review = useReview()
  const [correcting, setCorrecting] = useState(false)
  const prev = value.previous

  return (
    <Card onClick={onSelect} className={cn('cursor-pointer gap-4 transition-shadow', selected ? 'ring-2 ring-brand' : 'hover:ring-foreground/20')}>
      <CardHeader>
        <CardTitle>
          <button type="button" aria-pressed={selected} className="text-left hover:underline" onClick={onSelect}>
            {fieldLabel(value.fieldKey)}
          </button>
        </CardTitle>
        <CardAction>
          <ReviewBadge value={value} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ShownValue
          value={value.value}
          effectiveValue={value.effectiveValue}
          corrected={value.latestReview?.action === 'correct'}
          className="text-xl font-semibold tracking-tight"
        />
        {value.value === null && (
          <p className="text-sm text-muted-foreground">Why no value: {value.gapReason ?? 'the model gave no reason'}</p>
        )}
        {value.evidence && (
          // Blue like the evidence marked in the document text.
          <blockquote className="border-l-2 border-brand pl-3 text-sm whitespace-pre-line text-muted-foreground">{value.evidence}</blockquote>
        )}
        {value.latestReview?.note && <p className="text-sm">Note: {value.latestReview.note}</p>}

        {prev && isChanged(value) && (
          <div className="grid gap-1.5 rounded-xl bg-muted p-4">
            <p className="text-xs font-medium text-muted-foreground">Previous (v{prev.versionNo})</p>
            <ShownValue
              value={prev.value}
              effectiveValue={prev.effectiveValue}
              corrected={prev.latestReview?.action === 'correct'}
              className="text-base font-medium"
            />
            <ReviewLine review={prev.latestReview} />
          </div>
        )}

        {!readOnly &&
          (correcting ? (
            <CorrectForm value={value} documentId={documentId} onDone={() => setCorrecting(false)} onSaved={onReviewed} />
          ) : (
            <div className="flex gap-2">
              <Button
                // Black only where a review is still needed, so the page has one kind of primary action.
                variant={value.reviewStatus === 'pending' ? 'default' : 'outline'}
                size="lg"
                className="px-4"
                disabled={review.isPending}
                onClick={() => review.mutate({ valueId: value.id, documentId, input: { action: 'approve' } }, { onSuccess: onReviewed })}
              >
                <Check aria-hidden />
                Approve
              </Button>
              <Button size="lg" variant="outline" className="px-4" disabled={review.isPending} onClick={() => setCorrecting(true)}>
                <Pencil aria-hidden />
                Correct
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  )
}
