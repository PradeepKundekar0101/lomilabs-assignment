import { Router } from "express";
import { healthController } from "../controllers/health.controller.js";
import type { AppDeps } from "../types/app.js";

/** Mounted at `/health`. */
export function healthRoutes(deps: AppDeps): Router {
  const health = healthController(deps);
  return Router().get("/", health.check).get("/live", health.live);
}
