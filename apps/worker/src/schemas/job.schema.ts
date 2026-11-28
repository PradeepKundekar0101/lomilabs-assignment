import { z } from "zod";

/** Every producer (api upload, api retry, reconciler) adds `{ versionId }`; the claim casts it to uuid. */
export const ExtractJobSchema = z.object({ versionId: z.guid() });
