import { Link } from 'react-router'
import { useDocuments } from '@/api/hooks'
import { StatusBadge } from '@/components/StatusBadge'
import { UploadDialog } from '@/components/UploadDialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { sortForTriage, TYPE_LABELS } from '@/lib/review'

const COLUMNS = ['Title', 'Type', 'Version', 'Status', 'Progress']

export function DocumentListPage() {
  const { data, error } = useDocuments()

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <UploadDialog />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load documents</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((c) => (
                <TableHead key={c} className={c === 'Progress' ? 'w-64' : undefined}>
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data ? (
              [1, 2, 3].map((row) => (
                <TableRow key={row}>
                  {COLUMNS.map((c) => (
                    <TableCell key={c}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-muted-foreground">
                  No documents yet. Upload one to start.
                </TableCell>
              </TableRow>
            ) : (
              sortForTriage(data).map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell className="font-medium">
                    <Link to={`/documents/${doc.id}`} className="underline-offset-4 hover:underline">
                      {doc.title}
                    </Link>
                  </TableCell>
                  <TableCell>{TYPE_LABELS[doc.type]}</TableCell>
                  <TableCell>{doc.versionNo === null ? '-' : `v${doc.versionNo}`}</TableCell>
                  <TableCell>
                    <StatusBadge status={doc.status} error={doc.error} />
                  </TableCell>
                  <TableCell>
                    {doc.total === 0 ? (
                      <span className="text-muted-foreground">No values yet</span>
                    ) : (
                      <div className="grid gap-1.5">
                        <Progress value={((doc.total - doc.pending) / doc.total) * 100} aria-label={`${doc.title} review progress`} />
                        <span className="text-xs text-muted-foreground">
                          {doc.pending} pending · {doc.total - doc.pending} done
                        </span>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
