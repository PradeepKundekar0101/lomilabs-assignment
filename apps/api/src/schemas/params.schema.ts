import { z } from "zod";

/** Document ids are text: seeded documents keep the manifest's ids (`doc-invoice-001`), uploads get uuids. */
export const DocumentParamsSchema = z.object({ id: z.string().min(1) });

/** At most 9 digits, so the version number fits the int column. */
export const VersionParamsSchema = DocumentParamsSchema.extend({
  n: z
    .string()
    .regex(/^[1-9]\d{0,8}$/)
    .transform(Number),
});

/** Value ids are uuids; anything else could never match, and would fail the query's cast. */
export const ValueParamsSchema = z.object({ id: z.guid() });
