import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "./pdf.js";

const fixture = (name: string) => readFile(new URL(`../../../fixtures/documents/${name}`, import.meta.url));

// A valid one-page PDF with no content stream, like a scan without OCR.
const blankPdf = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

describe("extractPdfText", () => {
  it("extracts the fixture invoice in reading order, line breaks kept", async () => {
    const text = await extractPdfText(new Uint8Array(await fixture("invoice-001.pdf")));
    expect(text.startsWith("MERIDIAN OFFICE SUPPLIES LLC\n482 Commerce Way")).toBe(true);
    expect(text).toContain("Invoice Number: INV-2025-0847\nIssue Date: 2025-09-14");
    expect(text).toContain("Total Due: $5,230.29");
  });

  it("leaves the caller's bytes intact, so the same buffer can be parsed again", async () => {
    const bytes = new Uint8Array(await fixture("invoice-001.pdf"));
    const first = await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(await extractPdfText(bytes)).toBe(first);
  });

  it("throws no_text_layer for a PDF without text", async () => {
    await expect(extractPdfText(blankPdf)).rejects.toMatchObject({ code: "no_text_layer" });
  });
});
