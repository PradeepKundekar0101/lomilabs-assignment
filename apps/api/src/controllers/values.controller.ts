import { ReviewInputSchema } from "@lomi/shared";
import type { Request, Response } from "express";
import { HttpError } from "../errors.js";
import { ValueParamsSchema } from "../schemas/params.schema.js";
import { notFound, validate } from "../schemas/validate.js";
import { reviewValue } from "../services/reviews.service.js";
import type { AppDeps } from "../types/app.js";

const valueNotFound = notFound("value not found");

export function valuesController({ db }: Pick<AppDeps, "db">) {
  return {
    /** Approves or corrects a value of the current version (spec 004). */
    async review(req: Request, res: Response) {
      const { id } = await validate(ValueParamsSchema, req.params, valueNotFound);
      const input = await validate(ReviewInputSchema, req.body, (error) => new HttpError(400, "invalid review", { issues: error.issues }));
      const result = await reviewValue(db, id, input);
      if (result === "not_found") throw valueNotFound();
      if ("staleVersion" in result) throw new HttpError(409, "stale_version", { currentVersionNo: result.staleVersion });
      res.json(result);
    },
  };
}
