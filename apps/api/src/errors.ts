import type { VersionRejection } from "./types/versions.js";

/** An error that is its own response: `status` with `{ error: message, ...details }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Object storage did not take the file, so nothing was written. */
export class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super("object storage unavailable", { cause });
  }
}

/** A new version of an existing document was refused, and no row was written. */
export class VersionRejectedError extends Error {
  constructor(readonly reason: VersionRejection) {
    super(reason);
  }
}
