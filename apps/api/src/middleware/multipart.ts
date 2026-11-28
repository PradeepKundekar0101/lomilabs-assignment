import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { HttpError } from "../errors.js";
import { MAX_PDF_BYTES, TOO_LARGE } from "../schemas/upload.schema.js";

// Room for the multipart boundaries, part headers and the type field around a maximum-size file.
const MAX_BODY_BYTES = MAX_PDF_BYTES + 64 * 1024;

// A body over the cap is an oversized file: a validation error like the others, not body-parser's 413.
const oversizedFile: ErrorRequestHandler = (err, _req, _res, next) => next(err?.type === "entity.too.large" ? new HttpError(400, TOO_LARGE) : err);

/** Parses the raw body into `req.body` as a FormData, with Node's built-in parser. */
const toFormData: RequestHandler = async (req, _res, next) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "body must be multipart/form-data");
  try {
    // The Uint8Array copy (at most ~10 MB) is only because Node's types reject a Buffer as a BodyInit.
    req.body = await new Response(new Uint8Array(req.body), { headers: { "content-type": req.get("content-type")! } }).formData();
  } catch {
    throw new HttpError(400, "malformed multipart body");
  }
  next();
};

/** A multipart/form-data body, at most one maximum-size PDF plus its fields, as a FormData in `req.body`. */
export const multipart: (RequestHandler | ErrorRequestHandler)[] = [express.raw({ type: "multipart/form-data", limit: MAX_BODY_BYTES }), oversizedFile, toFormData];
