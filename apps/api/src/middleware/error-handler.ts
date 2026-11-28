import type { ErrorRequestHandler } from "express";
import { HttpError } from "../errors.js";

/** Every error response is `{ error, ...details }` (`ApiErrorBodySchema` in @lomi/shared). */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, ...err.details });
  // body-parser's errors (malformed JSON, a body over its limit) carry their status and a message for the client.
  if (err?.status) return void res.status(err.status).json({ error: err.message });
  console.error("unhandled error", err);
  res.status(500).json({ error: "internal error" });
};
