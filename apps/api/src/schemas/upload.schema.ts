import { DocumentTypeSchema } from "@lomi/shared";
import { z } from "zod";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const TOO_LARGE = "file must be at most 10 MB";

// Each message is the 400's `error`, so they are written for the client.
const PdfFileSchema = z
  .instanceof(File, { error: "file is required" })
  .refine((file) => file.size <= MAX_PDF_BYTES, { error: TOO_LARGE, abort: true })
  .refine(async (file) => (await file.slice(0, 5).text()) === "%PDF-", { error: "file is not a PDF" });

/** `POST /documents`: a new document of `type` from the PDF `file`. */
export const UploadFormSchema = z.object({
  type: z.enum(DocumentTypeSchema.options, { error: `type must be one of ${DocumentTypeSchema.options.join(", ")}` }),
  file: PdfFileSchema,
});

/** `POST /documents/:id/versions`: only the PDF; the type is the document's. */
export const NewVersionFormSchema = UploadFormSchema.pick({ file: true });
