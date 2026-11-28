import { Router } from "express";
import { documentsController } from "../controllers/documents.controller.js";
import { multipart } from "../middleware/multipart.js";
import type { AppDeps } from "../types/app.js";

/** Mounted at `/documents`. */
export function documentsRoutes(deps: AppDeps): Router {
  const documents = documentsController(deps);
  return Router()
    .get("/", documents.list)
    .post("/", multipart, documents.upload)
    .get("/:id", documents.get)
    .delete("/:id", documents.remove)
    .post("/:id/versions", multipart, documents.uploadVersion)
    .get("/:id/versions/:n", documents.getVersion)
    .get("/:id/progress", documents.progress)
    .post("/:id/retry", documents.retry);
}
