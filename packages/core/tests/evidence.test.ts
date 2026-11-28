import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { validateEvidence } from "../src/evidence.js";
import type { LlmField } from "../src/llm.js";
import { extractPdfText } from "../src/pdf.js";

const text = "INVOICE\nInvoice Number: INV-2025-0847\nThe initial term of this Lease shall be twenty-four (24)\nmonths, commencing on March 1, 2025";
const fields = (...keys: string[]) => keys.map((field) => ({ field, type: "string" }));
const llm = (key: string, value: string | null, evidence: string | null, reason: string | null = null): LlmField => ({ key, value, evidence, reason });

describe("validateEvidence", () => {
  it("keeps a value whose evidence matches exactly, with offsets into the original text", () => {
    const { values } = validateEvidence(text, fields("invoice_number"), [llm("invoice_number", "INV-2025-0847", "Invoice Number: INV-2025-0847")]);
    expect(values).toEqual([
      { fieldKey: "invoice_number", value: "INV-2025-0847", evidence: "Invoice Number: INV-2025-0847", evidenceStart: 8, evidenceEnd: 37, gapReason: null },
    ]);
    expect(text.slice(8, 37)).toBe("Invoice Number: INV-2025-0847");
  });

  it("matches across whitespace and newline differences and returns the original slice", () => {
    const quote = "  twenty-four   (24) months,\tcommencing ";
    const [v] = validateEvidence(text, fields("term_months"), [llm("term_months", "24", quote)]).values;
    expect(v).toMatchObject({ value: "24", gapReason: null });
    expect(v!.evidence).toBe("twenty-four (24)\nmonths, commencing");
    expect(text.slice(v!.evidenceStart!, v!.evidenceEnd!)).toBe(v!.evidence);
  });

  it("turns a hallucinated or missing quote into a gap", () => {
    const { values } = validateEvidence(text, fields("total", "due"), [llm("total", "$9,999.00", "Total Due: $9,999.00"), llm("due", "2025-10-14", null)]);
    expect(values.map((v) => [v.fieldKey, v.value, v.evidence, v.gapReason])).toEqual([
      ["total", null, null, "evidence_not_found"],
      ["due", null, null, "evidence_not_found"],
    ]);
  });

  it("turns a null value into a gap with the model's reason, or not_found", () => {
    const { values } = validateEvidence(text, fields("income", "author"), [
      llm("income", null, null, "The report does not state household income."),
      llm("author", null, "INVOICE", "  "),
    ]);
    expect(values.map((v) => [v.value, v.evidence, v.gapReason])).toEqual([
      [null, null, "The report does not state household income."],
      [null, null, "not_found"],
    ]);
  });

  it("gives every expected field exactly one row, even when the model omitted it", () => {
    const { values } = validateEvidence(text, fields("invoice_number", "vendor_name"), [
      llm("invoice_number", "INV-2025-0847", "INV-2025-0847"),
      llm("invoice_number", "other", "INVOICE"),
    ]);
    expect(values.map((v) => [v.fieldKey, v.value, v.gapReason])).toEqual([
      ["invoice_number", "INV-2025-0847", null],
      ["vendor_name", null, "missing_from_llm_output"],
    ]);
  });

  it("drops fields that are not expected and reports them", () => {
    const result = validateEvidence(text, fields("invoice_number"), [
      llm("invoice_number", "INV-2025-0847", "INV-2025-0847"),
      llm("customer_name", "Lomi Labs", "INVOICE"),
    ]);
    expect(result.values.map((v) => v.fieldKey)).toEqual(["invoice_number"]);
    expect(result.dropped).toEqual(["customer_name"]);
  });
});

describe("validateEvidence against the fixture text", () => {
  const parse = async (name: string) =>
    extractPdfText(new Uint8Array(await readFile(new URL(`../../../fixtures/documents/${name}`, import.meta.url))));
  let invoice: string;
  let lease: string;
  beforeAll(async () => {
    [invoice, lease] = await Promise.all([parse("invoice-001.pdf"), parse("lease-excerpt-001.pdf")]);
  });

  it("rejects a real quote whose value is not in it", () => {
    const [v] = validateEvidence(invoice, fields("total_amount"), [llm("total_amount", "$9,999.00", "Total Due: $5,230.29")]).values;
    expect(v).toEqual({ fieldKey: "total_amount", value: null, evidence: null, evidenceStart: null, evidenceEnd: null, gapReason: "value_not_in_evidence" });
  });

  it("keeps a real quote that contains its value, with offsets into the parsed text", () => {
    const [v] = validateEvidence(invoice, fields("total_amount"), [llm("total_amount", "$5,230.29", "Total Due: $5,230.29")]).values;
    expect(v).toMatchObject({ value: "$5,230.29", evidence: "Total Due: $5,230.29", gapReason: null });
    expect(invoice.slice(v!.evidenceStart!, v!.evidenceEnd!)).toBe(v!.evidence);
  });

  it("keeps a value that the parsed text splits across a line break inside the quote", () => {
    const quote = "The initial term of this Lease shall be twenty-four (24) months";
    const [v] = validateEvidence(lease, fields("term_months"), [llm("term_months", "twenty-four (24) months", quote)]).values;
    expect(v).toMatchObject({ value: "twenty-four (24) months", gapReason: null });
    expect(v!.evidence).toBe("The initial term of this Lease shall be twenty-four (24)\nmonths");
    expect(lease.slice(v!.evidenceStart!, v!.evidenceEnd!)).toBe(v!.evidence);
  });
});
