import type { ExpectedFields } from "@lomi/core";
import { DocumentType, type PrismaClient } from "@lomi/db";
import express, { type Express } from "express";
import { z } from "zod";
import { StorageUnavailableError, type CreateVersionResult, type VersionTarget } from "./create-version.js";
import type { RetryResult } from "./retry.js";
import { documentProgress, documentView, ReviewInputSchema, reviewValue } from "./review.js";

/** Each check returns counts, so a successful count is also the service's health check. */
export interface HealthChecks {
  /** Document versions per status. */
  db: () => Promise<Record<string, number>>;
  /** Extraction jobs waiting and active. */
  redis: () => Promise<Record<string, number>>;
}

export interface AppDeps {
  checks: HealthChecks;
  db: PrismaClient;
  /** Expected fields per document type: their order is the values' order within a review group. */
  fields: ExpectedFields;
  createVersion: (target: VersionTarget, file: File) => Promise<CreateVersionResult>;
  retry: (documentId: string) => Promise<RetryResult>;
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;
// Room for the multipart boundaries, part headers and the type field around a maximum-size file.
const MAX_BODY_BYTES = MAX_PDF_BYTES + 64 * 1024;
const TOO_LARGE = "file must be at most 10 MB";
const documentTypes: readonly string[] = Object.values(DocumentType);

export function createApp({ checks, db, fields, createVersion, retry }: AppDeps): Express {
  const app = express();

  app.get("/health", async (_req, res) => {
    const [dbCheck, redis] = await Promise.allSettled([checks.db(), checks.redis()]);
    const body = {
      db: dbCheck.status === "fulfilled" ? "ok" : "error",
      redis: redis.status === "fulfilled" ? "ok" : "error",
      versions: dbCheck.status === "fulfilled" ? dbCheck.value : null,
      queue: redis.status === "fulfilled" ? redis.value : null,
    };
    for (const [name, r] of Object.entries({ db: dbCheck, redis })) {
      if (r.status === "rejected") console.error(`health: ${name} check failed`, r.reason);
    }
    res.status(body.db === "ok" && body.redis === "ok" ? 200 : 503).json(body);
  });

  // multipart/form-data with fields `type` and `file`, parsed by Node's built-in FormData parser.
  app.post("/documents", express.raw({ type: "multipart/form-data", limit: MAX_BODY_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      return void res.status(415).json({ error: "body must be multipart/form-data" });
    }
    let form: FormData;
    // The Uint8Array copy (at most ~10 MB) is only because Node's types reject a Buffer as a BodyInit.
    try {
      form = await new Response(new Uint8Array(req.body), { headers: { "content-type": req.get("content-type")! } }).formData();
    } catch {
      return void res.status(400).json({ error: "malformed multipart body" });
    }
    const type = form.get("type");
    const file = form.get("file");
    if (typeof type !== "string" || !documentTypes.includes(type)) {
      return void res.status(400).json({ error: `type must be one of ${documentTypes.join(", ")}` });
    }
    if (!(file instanceof File)) {
      return void res.status(400).json({ error: "file is required" });
    }
    if (file.size > MAX_PDF_BYTES) {
      return void res.status(400).json({ error: TOO_LARGE });
    }
    if ((await file.slice(0, 5).text()) !== "%PDF-") {
      return void res.status(400).json({ error: "file is not a PDF" });
    }
    try {
      const { documentId, versionId, status } = await createVersion({ type: type as DocumentType, title: file.name || "untitled" }, file);
      res.status(202).json({ id: documentId, versionId, status });
    } catch (err) {
      console.error("upload failed", err);
      if (err instanceof StorageUnavailableError) {
        return void res.status(503).json({ error: "object storage unavailable, try again later" });
      }
      res.status(500).json({ error: "upload failed" });
    }
  });

  app.get("/documents", async (_req, res) => {
    // shortcut: unpaginated, add cursor pagination when the list gets long.
    const docs = await db.document.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, type: true, currentVersion: { select: { versionNo: true, status: true } } },
    });
    res.json(
      docs.map(({ currentVersion, ...doc }) => ({
        ...doc,
        versionNo: currentVersion?.versionNo ?? null,
        status: currentVersion?.status ?? null,
      })),
    );
  });

  app.get("/documents/:id", async (req, res) => {
    const view = await documentView(db, fields, req.params.id);
    if (!view) return void res.status(404).json({ error: "document not found" });
    res.json(view);
  });

  app.get("/documents/:id/versions/:n", async (req, res) => {
    // At most 9 digits, so it fits the int column.
    const view = /^[1-9]\d{0,8}$/.test(req.params.n) ? await documentView(db, fields, req.params.id, Number(req.params.n)) : null;
    if (!view) return void res.status(404).json({ error: "document version not found" });
    res.json(view);
  });

  app.get("/documents/:id/progress", async (req, res) => {
    const progress = await documentProgress(db, req.params.id);
    if (!progress) return void res.status(404).json({ error: "document not found" });
    res.json(progress);
  });

  app.post("/values/:id/review", express.json(), async (req, res) => {
    // Value ids are uuids; anything else could never match, and would fail the query's cast.
    if (!z.guid().safeParse(req.params.id).success) return void res.status(404).json({ error: "value not found" });
    const input = ReviewInputSchema.safeParse(req.body);
    if (!input.success) return void res.status(400).json({ error: "invalid review", issues: input.error.issues });
    const result = await reviewValue(db, req.params.id, input.data);
    if (result === "not_found") return void res.status(404).json({ error: "value not found" });
    if ("staleVersion" in result) return void res.status(409).json({ error: "stale_version", currentVersionNo: result.staleVersion });
    res.json(result);
  });

  app.post("/documents/:id/retry", async (req, res) => {
    const result = await retry(req.params.id);
    if (result === "not_found") return void res.status(404).json({ error: "document not found" });
    if (result === "not_failed") return void res.status(409).json({ error: "only a failed extraction can be retried" });
    res.status(202).json({ id: req.params.id, versionId: result.versionId, status: "queued" });
  });

  app.use(
    (
      err: { status?: number; type?: string; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      // A body over the cap is an oversized file: a validation error like the others, not body-parser's 413.
      if (err.type === "entity.too.large") return void res.status(400).json({ error: TOO_LARGE });
      if (!err.status) console.error("unhandled error", err);
      res.status(err.status ?? 500).json({ error: err.status ? err.message : "internal error" });
    },
  );

  return app;
}
