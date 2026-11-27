import type { VersionStatus } from '@lomi/shared'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A version's extraction status; a failed one shows its error on hover and focus. */
export function StatusBadge({ status, error }: { status: VersionStatus | null; error?: string | null }) {
  switch (status) {
    case 'queued':
      return <Badge variant="secondary">Queued</Badge>
    case 'extracting':
      return (
        <Badge variant="secondary">
          <Loader2 className="animate-spin" aria-hidden />
          Extracting
        </Badge>
      )
    case 'extracted':
      return <Badge className="bg-green-600 text-white">Extracted</Badge>
    case 'failed':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive" tabIndex={0}>
              Failed
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{error ?? 'No error recorded'}</TooltipContent>
        </Tooltip>
      )
    case 'superseded':
      return <Badge variant="outline">Superseded</Badge>
    case null:
      return <Badge variant="outline">No version</Badge>
  }
}
