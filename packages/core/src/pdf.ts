import { extractText, getDocumentProxy } from "unpdf";
import { ExtractionError } from "./errors.js";

/**
 * The PDF's text exactly as pdf.js outputs it, in reading order. Evidence offsets point into this
 * string, so it is stored as-is and never normalized.
 */
export async function extractPdfText(pdf: Uint8Array): Promise<string> {
  // pdf.js transfers (detaches) the buffer it is given; a copy keeps the caller's bytes usable.
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(doc, { mergePages: true });
  if (!text.trim()) throw new ExtractionError("no_text_layer", "the PDF has no extractable text (scanned or image-only)");
  return text;
}
