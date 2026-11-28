import express, { Router } from "express";
import { valuesController } from "../controllers/values.controller.js";
import type { AppDeps } from "../types/app.js";

/** Mounted at `/values`. */
export function valuesRoutes(deps: AppDeps): Router {
  const values = valuesController(deps);
  return Router().post("/:id/review", express.json(), values.review);
}
