import { DocumentTypeSchema, type DocumentType } from '@lomi/shared'
import { Upload } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useUploadDocument, useUploadVersion } from '@/api/hooks'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TYPE_LABELS } from '@/lib/review'

/** Uploads a new document, or with `documentId` a new version of that document (its type is the document's). */
export function UploadDialog({ documentId }: { documentId?: string }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<DocumentType>()
  const [file, setFile] = useState<File>()
  const uploadDocument = useUploadDocument()
  const uploadVersion = useUploadVersion(documentId ?? '')
  const upload = documentId ? uploadVersion : uploadDocument
  const label = documentId ? 'Upload new version' : 'Upload document'

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setType(undefined)
      setFile(undefined)
      upload.reset()
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    const done = { onSuccess: () => (onOpenChange(false), toast.success(`${file.name} uploaded; extraction queued`)) }
    if (documentId) uploadVersion.mutate(file, done)
    else if (type) uploadDocument.mutate({ type, file }, done)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={documentId ? 'outline' : 'default'}>
          <Upload aria-hidden />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {documentId
                ? 'Reviews carry over to the new version wherever a value did not change.'
                : 'A PDF of at most 10 MB. Extraction starts as soon as it is uploaded.'}
            </DialogDescription>
          </DialogHeader>
          {!documentId && (
            <div className="grid gap-2">
              <Label htmlFor="upload-type">Type</Label>
              <Select value={type ?? ''} onValueChange={(v) => setType(DocumentTypeSchema.parse(v))}>
                <SelectTrigger id="upload-type" className="w-full">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {DocumentTypeSchema.options.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="upload-file">PDF file</Label>
            <Input id="upload-file" type="file" accept="application/pdf,.pdf" onChange={(e) => (setFile(e.target.files?.[0]), upload.reset())} />
          </div>
          {upload.error && (
            <Alert variant="destructive">
              <AlertDescription>{upload.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!file || (!documentId && !type) || upload.isPending}>
              {upload.isPending ? 'Uploading...' : 'Upload'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
