import { useState, type ReactNode } from 'react'
import { useDeleteDocument } from '@/api/hooks'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/** Asks before deleting a document (spec 011); `onDeleted` runs once the API confirmed it. */
export function DeleteDialog({ id, title, trigger, onDeleted }: { id: string; title: string; trigger: ReactNode; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false)
  const deletion = useDeleteDocument()

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) deletion.reset()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete document?</DialogTitle>
          <DialogDescription>
            <span className="font-medium break-all text-foreground">{title}</span> leaves the app with its versions and reviews. It can't be
            restored from here.
          </DialogDescription>
        </DialogHeader>
        {deletion.error && (
          <Alert variant="destructive">
            <AlertDescription>{deletion.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" size="lg" className="h-10.75 px-5" disabled={deletion.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="lg"
            className="h-10.75 px-5"
            disabled={deletion.isPending}
            onClick={() => deletion.mutate({ id, title }, { onSuccess: () => (setOpen(false), onDeleted?.()) })}
          >
            {deletion.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
