import { createId, type Job } from "@lomi/shared";

export function createJob(type: string, payload: unknown): Job {
  if (!type.trim()) throw new Error("Job type is required");
  return { id: createId("job"), type, payload, status: "queued", createdAt: new Date() };
}

export { ExtractionError, type ExtractionErrorCode } from "./errors.js";
export { extractPdfText } from "./pdf.js";
export {
  buildPrompt,
  createLlm,
  ExpectedFieldsSchema,
  LlmOutputSchema,
  parseLlmOutput,
  type ExpectedField,
  type ExpectedFields,
  type Llm,
  type LlmField,
  type LlmResponse,
  type Prompt,
} from "./llm.js";
export { validateEvidence, type EvidenceResult, type ValidatedValue } from "./evidence.js";
