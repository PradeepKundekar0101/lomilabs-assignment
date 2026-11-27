import { describe, expect, it } from "vitest";
import { ExtractionError } from "./errors.js";
import { buildPrompt, parseLlmOutput, type LlmResponse } from "./llm.js";

const response = (text: string | null, stopReason = "end_turn"): LlmResponse => ({ raw: "{}", text, stopReason, tokensIn: 1, tokensOut: 1 });
const field = { key: "invoice_number", value: "INV-1", evidence: "INV-1", reason: null };

describe("buildPrompt", () => {
  it("lists the fields with their types and wraps the document text unchanged", () => {
    const { system, user } = buildPrompt([{ field: "invoice_number", type: "string" }, { field: "total_amount", type: "money" }], "A  B\nC");
    expect(user).toBe("Fields to extract:\n- invoice_number (string)\n- total_amount (money)\n\n<document>\nA  B\nC\n</document>");
    expect(system).toMatch(/exact quote/);
    expect(system).toMatch(/Never infer/);
  });
});

describe("parseLlmOutput", () => {
  it("returns the fields of a valid response", () => {
    expect(parseLlmOutput(response(JSON.stringify({ fields: [field] })))).toEqual([field]);
  });

  it.each([
    ["not JSON", response("{fields: oops")],
    ["no text", response(null)],
    ["wrong shape", response(JSON.stringify({ fields: [{ key: "x", value: 5 }] }))],
    ["a refusal", response(JSON.stringify({ fields: [field] }), "refusal")],
    ["truncated output", response(JSON.stringify({ fields: [field] }), "max_tokens")],
  ])("rejects %s as llm_invalid_output", (_name, r) => {
    expect(() => parseLlmOutput(r)).toThrow(expect.objectContaining({ code: "llm_invalid_output" }) as ExtractionError);
  });
});
