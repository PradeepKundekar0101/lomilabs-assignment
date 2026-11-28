import { DocumentTypeSchema } from "@lomi/shared";
import { z } from "zod";

/** fixtures/documents.json: the documents to seed, each with its versions' files relative to the fixtures folder. */
export const ManifestSchema = z.array(
  z.object({
    id: z.string().min(1),
    type: DocumentTypeSchema,
    title: z.string().min(1),
    versions: z.array(z.object({ version: z.number().int().positive(), file: z.string().min(1) })),
  }),
);
