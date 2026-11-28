import type { z } from "zod";
import { HttpError } from "../errors.js";

/** Parses a request's `input` with `schema`, or throws the HttpError `toError` makes of the failure. */
export async function validate<S extends z.ZodType>(schema: S, input: unknown, toError: (error: z.ZodError) => HttpError): Promise<z.output<S>> {
  // Async: the upload schema reads the file's first bytes.
  const result = await schema.safeParseAsync(input);
  if (!result.success) throw toError(result.error);
  return result.data;
}

/** A 400 with the first issue's message, for schemas whose messages are written for the client. */
export const badRequest = (error: z.ZodError) => new HttpError(400, error.issues[0]!.message);

/** A 404: a param that cannot name a row is the same as one that names no row. */
export const notFound = (message: string) => () => new HttpError(404, message);
