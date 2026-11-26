import { DocumentType } from "@lomi/db";
import express, { type Express } from "express";
import type { UploadInput, UploadResult } from "./upload.js";

export interface HealthChecks {
  db: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface AppDeps {
  checks: HealthChecks;
  upload: (input: UploadInput) => Promise<UploadResult>;
}

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const documentTypes: readonly string[] = Object.values(DocumentType);

export function createApp({ checks, upload }: AppDeps): Express {
  const app = express();

  app.get("/health", async (_req, res) => {
    const [db, redis] = await Promise.allSettled([checks.db(), checks.redis()]);
    const body = {
      db: db.status === "fulfilled" ? "ok" : "error",
      redis: redis.status === "fulfilled" ? "ok" : "error",
    };
    for (const [name, r] of Object.entries({ db, redis })) {
      if (r.status === "rejected") console.error(`health: ${name} check failed`, r.reason);
    }
    res.status(body.db === "ok" && body.redis === "ok" ? 200 : 503).json(body);
  });

  // Raw PDF body; metadata in the query string: POST /documents?type=invoice&title=March
  app.post("/documents", express.raw({ type: "application/pdf", limit: MAX_PDF_BYTES }), async (req, res) => {
    const { type, title } = req.query;
    if (typeof type !== "string" || !documentTypes.includes(type)) {
      return void res.status(400).json({ error: `type must be one of ${documentTypes.join(", ")}` });
    }
    if (typeof title !== "string" || !title.trim()) {
      return void res.status(400).json({ error: "title is required" });
    }
    if (!Buffer.isBuffer(req.body)) {
      return void res.status(415).json({ error: "body must be sent as Content-Type: application/pdf" });
    }
    if (req.body.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return void res.status(400).json({ error: "body is not a PDF" });
    }
    try {
      res.status(201).json(await upload({ type: type as DocumentType, title: title.trim(), pdf: req.body }));
    } catch (err) {
      console.error("upload failed", err);
      res.status(500).json({ error: "upload failed" });
    }
  });

  // express.raw rejects oversized bodies with a 413 PayloadTooLargeError; keep it a JSON response.
  app.use((err: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.status ? err.message : "internal error" });
  });

  return app;
}
