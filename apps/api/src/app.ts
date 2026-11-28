import express, { type Express } from "express";
import { errorHandler } from "./middleware/error-handler.js";
import { documentsRoutes } from "./routes/documents.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { valuesRoutes } from "./routes/values.routes.js";
import type { AppDeps } from "./types/app.js";

/** The HTTP API: routes call controllers, controllers validate and call services, and every error ends in `errorHandler`. */
export function createApp(deps: AppDeps): Express {
  return express()
    .use("/health", healthRoutes(deps))
    .use("/documents", documentsRoutes(deps))
    .use("/values", valuesRoutes(deps))
    .use(errorHandler);
}
