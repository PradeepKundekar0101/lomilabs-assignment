import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ExtractionError } from "../src/errors.js";
import { buildPrompt, createLlm, parseLlmOutput, type LlmResponse } from "../src/llm.js";

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

describe("createLlm", () => {
  const failingClient = (err: unknown) => ({ beta: { messages: { create: () => Promise.reject(err) } } }) as unknown as Anthropic;
  const prompt = { system: "s", user: "u" };

  it("turns an API error into a readable llm_request_failed, without the raw JSON body", async () => {
    const body = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
    const err = Anthropic.APIError.generate(401, body, undefined, new Headers());
    await expect(createLlm("m", failingClient(err))(prompt)).rejects.toMatchObject({
      code: "llm_request_failed",
      message: "401 authentication_error: invalid x-api-key",
    });
  });

  it("keeps the message of an error without a status, such as a connection error", async () => {
    await expect(createLlm("m", failingClient(new Error("Connection error.")))(prompt)).rejects.toMatchObject({
      code: "llm_request_failed",
      message: "Connection error.",
    });
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
