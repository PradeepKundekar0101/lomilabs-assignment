import { Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { useDocuments } from '@/api/hooks'
import { DeleteDialog } from '@/components/DeleteDialog'
import { StatusBadge } from '@/components/StatusBadge'
import { UploadDialog } from '@/components/UploadDialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { sortForTriage, TYPE_LABELS } from '@/lib/review'
import { cn } from '@/lib/utils'

// Phones show the title (with the counts under it) and the status; the other columns need a wider screen.
const NARROW_HIDDEN = 'max-md:hidden'
const COLUMNS = ['Title', 'Type', 'Version', 'Status', 'Progress', 'Actions']
const columnClass = (c: string) =>
  c === 'Type' || c === 'Version' ? NARROW_HIDDEN : c === 'Progress' ? 'max-sm:hidden md:w-64' : c === 'Actions' ? 'w-px' : undefined
// The first and last columns sit a little further in, like the card's padding.
const PAD = 'px-4 first:pl-5 last:pr-5'
const CELL = cn(PAD, 'py-3.5')

export function DocumentListPage() {
  const { data, error } = useDocuments()

  return (
    <div className="grid gap-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1.5">
          <h1 className="text-headline-lg text-primary">Documents</h1>
          <p className="text-muted-foreground">Failed extractions come first, then documents in progress or with values to review.</p>
        </div>
        <UploadDialog />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load documents</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {COLUMNS.map((c) => (
                  <TableHead key={c} className={cn(PAD, 'h-11 text-xs text-muted-foreground', columnClass(c))}>
                    {c === 'Actions' ? <span className="sr-only">{c}</span> : c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data ? (
                [1, 2, 3].map((row) => (
                  <TableRow key={row}>
                    {COLUMNS.map((c) => (
                      <TableCell key={c} className={cn(CELL, columnClass(c))}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={COLUMNS.length} className="py-14 text-center text-muted-foreground">
                    No documents yet. Upload one to start.
                  </TableCell>
                </TableRow>
              ) : (
                sortForTriage(data).map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className={cn(CELL, 'font-medium whitespace-normal')}>
                      <Link to={`/documents/${doc.id}`} className="text-foreground underline-offset-4 hover:underline">
                        {doc.title}
                      </Link>
                      <span className="mt-1 block text-xs font-normal text-muted-foreground sm:hidden">
                        {doc.total === 0 ? 'No values yet' : `${doc.pending} pending · ${doc.total - doc.pending} done`}
                      </span>
                    </TableCell>
                    <TableCell className={cn(CELL, NARROW_HIDDEN, 'text-muted-foreground')}>{TYPE_LABELS[doc.type]}</TableCell>
                    <TableCell className={cn(CELL, NARROW_HIDDEN, 'font-mono text-xs text-muted-foreground')}>
                      {doc.versionNo === null ? '-' : `v${doc.versionNo}`}
                    </TableCell>
                    <TableCell className={CELL}>
                      <StatusBadge status={doc.status} error={doc.error} />
                    </TableCell>
                    <TableCell className={cn(CELL, 'max-sm:hidden')}>
                      {doc.total === 0 ? (
                        <span className="text-xs text-muted-foreground">No values yet</span>
                      ) : (
                        <div className="grid gap-1.5">
                          <Progress
                            value={((doc.total - doc.pending) / doc.total) * 100}
                            className="h-1.5"
                            aria-label={`${doc.title} review progress`}
                          />
                          <span className="text-xs text-muted-foreground">
                            {doc.pending} pending · {doc.total - doc.pending} done
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className={cn(PAD, 'py-2 text-right')}>
                      <DeleteDialog
                        id={doc.id}
                        title={doc.title}
                        trigger={
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${doc.title}`}>
                            <Trash2 aria-hidden />
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
