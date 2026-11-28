import type { Request, Response } from "express";
import { HttpError, StorageUnavailableError, VersionRejectedError } from "../errors.js";
import { DocumentParamsSchema, VersionParamsSchema } from "../schemas/params.schema.js";
import { NewVersionFormSchema, UploadFormSchema } from "../schemas/upload.schema.js";
import { badRequest, notFound, validate } from "../schemas/validate.js";
import { getDocumentProgress, getDocumentView, listDocuments } from "../services/documents.service.js";
import type { AppDeps } from "../types/app.js";
import type { VersionTarget } from "../types/versions.js";

const documentNotFound = notFound("document not found");

export function documentsController(deps: AppDeps) {
  /** Stores an uploaded PDF as a new version of `target`, and answers 202 with it. */
  async function store(res: Response, target: VersionTarget, file: File) {
    try {
      const { documentId, versionId, versionNo, status } = await deps.createVersion(target, file);
      res.status(202).json({ id: documentId, versionId, versionNo, status });
    } catch (err) {
      if (err instanceof VersionRejectedError) {
        throw err.reason === "document_not_found" ? documentNotFound() : new HttpError(409, err.reason);
      }
      console.error("upload failed", err);
      if (err instanceof StorageUnavailableError) throw new HttpError(503, "object storage unavailable, try again later");
      throw new HttpError(500, "upload failed");
    }
  }

  return {
    async list(_req: Request, res: Response) {
      res.json(await listDocuments(deps.db));
    },

    /** A new document: multipart/form-data with a `type` and a PDF `file`. */
    async upload(req: Request, res: Response) {
      const form: FormData = req.body;
      const { type, file } = await validate(UploadFormSchema, { type: form.get("type"), file: form.get("file") }, badRequest);
      await store(res, { type, title: file.name || "untitled" }, file);
    },

    /** A new version of an existing document (spec 005): multipart/form-data with a PDF `file`; the type is the document's. */
    async uploadVersion(req: Request, res: Response) {
      const { id } = await validate(DocumentParamsSchema, req.params, documentNotFound);
      const form: FormData = req.body;
      const { file } = await validate(NewVersionFormSchema, { file: form.get("file") }, badRequest);
      await store(res, { documentId: id }, file);
    },

    async get(req: Request, res: Response) {
      const { id } = await validate(DocumentParamsSchema, req.params, documentNotFound);
      const view = await getDocumentView(deps.db, deps.fields, id);
      if (!view) throw documentNotFound();
      res.json(view);
    },

    async getVersion(req: Request, res: Response) {
      const versionNotFound = notFound("document version not found");
      const { id, n } = await validate(VersionParamsSchema, req.params, versionNotFound);
      const view = await getDocumentView(deps.db, deps.fields, id, n);
      if (!view) throw versionNotFound();
      res.json(view);
    },

    async progress(req: Request, res: Response) {
      const { id } = await validate(DocumentParamsSchema, req.params, documentNotFound);
      const progress = await getDocumentProgress(deps.db, id);
      if (!progress) throw documentNotFound();
      res.json(progress);
    },

    /** Requeues the current version if its extraction failed (spec 007). */
    async retry(req: Request, res: Response) {
      const { id } = await validate(DocumentParamsSchema, req.params, documentNotFound);
      const result = await deps.retry(id);
      if (result === "not_found") throw documentNotFound();
      if (result === "not_failed") throw new HttpError(409, "only a failed extraction can be retried");
      res.status(202).json({ id, versionId: result.versionId, status: "queued" });
    },
  };
}
