import type { VersionStatus } from '@lomi/shared'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The design system's chip: a small white pill, its status told by a colored dot. */
export function DotBadge({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <Badge variant="outline" className="h-6 gap-1.5 bg-card px-2.5">
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden />
      {children}
    </Badge>
  )
}

/** A version's extraction status; a failed one stays red and shows its error on hover and focus. */
export function StatusBadge({ status, error }: { status: VersionStatus | null; error?: string | null }) {
  switch (status) {
    case 'queued':
      return <DotBadge dot="bg-muted-foreground">Queued</DotBadge>
    case 'extracting':
      return (
        <Badge variant="outline" className="h-6 gap-1.5 bg-card px-2.5">
          <Loader2 className="animate-spin text-brand" aria-hidden />
          Extracting
        </Badge>
      )
    case 'extracted':
      return <DotBadge dot="bg-emerald-500">Extracted</DotBadge>
    case 'failed':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive" className="h-6 px-2.5" tabIndex={0}>
              Failed
            </Badge>
          </TooltipTrigger>
          {/* Errors can hold long unbroken tokens (ids, JSON) that would overflow the bubble. */}
          <TooltipContent className="wrap-anywhere">{error ?? 'No error recorded'}</TooltipContent>
        </Tooltip>
      )
    case 'superseded':
      return <DotBadge dot="bg-muted-foreground/40">Superseded</DotBadge>
    case null:
      return <DotBadge dot="bg-muted-foreground/40">No version</DotBadge>
  }
}
