import type { PrismaClient } from "@lomi/db";
import type { z } from "zod";
import type { ManifestSchema } from "../schemas/manifest.schema.js";
import type { CreateVersionDeps } from "./versions.js";

/** An entry of fixtures/documents.json. */
export type ManifestDocument = z.infer<typeof ManifestSchema>[number];

export type SeedDeps = CreateVersionDeps & { db: Pick<PrismaClient, "$transaction" | "document"> };
