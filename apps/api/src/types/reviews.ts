import type { Prisma } from "@lomi/db";
import type { toValueView, valueSelect } from "../services/value-view.js";

/** A value as `valueSelect` reads it, with its latest review and its previous version's value. */
export type StoredValue = Prisma.ExtractedValueGetPayload<{ select: typeof valueSelect }>;
export type LatestReview = StoredValue["reviews"][number];

/** A value as the api returns it (`ValueSchema` in @lomi/shared, before JSON turns dates into strings). */
export type ValueView = ReturnType<typeof toValueView>;

export type ReviewResult = ValueView | "not_found" | { staleVersion: number | null };
