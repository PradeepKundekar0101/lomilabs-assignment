/** The API's request and response shapes, shared by the api (which produces them) and the web app (which parses them). */
import { z } from "zod";

export const DocumentTypeSchema = z.enum(["invoice", "lease", "market_report"]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;
export const VersionStatusSchema = z.enum(["queued", "extracting", "extracted", "failed", "superseded"]);
export type VersionStatus = z.infer<typeof VersionStatusSchema>;
export const ReviewStatusSchema = z.enum(["pending", "approved", "corrected", "carried_over"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const note = z.string().max(1000).optional();

/** Strict, so an approve that carries a correctedValue is rejected rather than silently stripped. */
export const ReviewInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("approve"), note }),
  z.strictObject({ action: z.literal("correct"), correctedValue: z.string().trim().min(1), note }),
]);
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const ReviewSchema = z.object({
  action: z.enum(["approve", "correct"]),
  correctedValue: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ValueSchema = z.object({
  id: z.string(),
  fieldKey: z.string(),
  value: z.string().nullable(),
  evidence: z.string().nullable(),
  evidenceStart: z.number().int().nullable(),
  evidenceEnd: z.number().int().nullable(),
  gapReason: z.string().nullable(),
  reviewStatus: ReviewStatusSchema,
  effectiveValue: z.string().nullable(),
  latestReview: ReviewSchema.nullable(),
  previous: z
    .object({ versionNo: z.number().int(), value: z.string().nullable(), effectiveValue: z.string().nullable(), latestReview: ReviewSchema.nullable() })
    .nullable(),
});
export type Value = z.infer<typeof ValueSchema>;

const VersionSchema = z.object({
  id: z.string(),
  versionNo: z.number().int(),
  status: VersionStatusSchema,
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
});

export const DocumentViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: DocumentTypeSchema,
  createdAt: z.string(),
  currentVersion: VersionSchema.nullable(),
  /** The version `values` belong to, with the text its evidence offsets point into. */
  version: VersionSchema.extend({ parsedText: z.string().nullable() }).nullable(),
  values: z.array(ValueSchema),
});
export type DocumentView = z.infer<typeof DocumentViewSchema>;

export const DocumentListSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    type: DocumentTypeSchema,
    versionNo: z.number().int().nullable(),
    status: VersionStatusSchema.nullable(),
    error: z.string().nullable(),
    /** Review counts of the current version's values. */
    total: z.number().int(),
    pending: z.number().int(),
  }),
);
export type DocumentListItem = z.infer<typeof DocumentListSchema>[number];

export const ProgressSchema = z.object({
  versionNo: z.number().int().nullable(),
  status: VersionStatusSchema.nullable(),
  total: z.number().int(),
  pending: z.number().int(),
  approved: z.number().int(),
  corrected: z.number().int(),
  carriedOver: z.number().int(),
  gaps: z.number().int(),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const UploadResultSchema = z.object({ id: z.string(), versionId: z.string(), versionNo: z.number().int(), status: VersionStatusSchema });
export const RetryResultSchema = z.object({ id: z.string(), versionId: z.string(), status: VersionStatusSchema });

/** Every error response; `stale_version` also carries the current version's number. */
export const ApiErrorBodySchema = z.object({ error: z.string(), currentVersionNo: z.number().int().nullable().optional() });
