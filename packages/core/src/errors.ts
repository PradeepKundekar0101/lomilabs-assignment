export type ExtractionErrorCode =
  | "no_text_layer"
  | "llm_request_failed"
  | "llm_invalid_output"
  | "unknown_document_type";

/** An expected extraction failure; `code` is stored on the version so a user can see why it failed. */
export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}
