import type { ExpectedField, LlmField } from "./llm.js";

/** One row for extracted_values: either a value with verified evidence, or a gap with a reason. */
export interface ValidatedValue {
  fieldKey: string;
  value: string | null;
  evidence: string | null;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  gapReason: string | null;
}

export interface EvidenceResult {
  values: ValidatedValue[];
  /** Keys the model returned that are not expected for this document type. */
  dropped: string[];
}

/** Collapses whitespace runs to one space and trims; map[i] is the original index of text[i]. */
function normalize(original: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (const m of original.matchAll(/\S+/g)) {
    if (text) {
      text += " ";
      map.push(m.index - 1);
    }
    text += m[0];
    for (let i = 0; i < m[0].length; i++) map.push(m.index + i);
  }
  return { text, map };
}

/** Whitespace runs collapsed to one space, trimmed: the comparison evidence validation and carry-over use. */
export const norm = (s: string) => normalize(s).text;

/** Shorter quotes (after norm) like "2025" or "$5" can match in many places, so they locate nothing. */
export const MIN_QUOTE_LENGTH = 6;

const gap = (fieldKey: string, gapReason: string): ValidatedValue => ({
  fieldKey,
  value: null,
  evidence: null,
  evidenceStart: null,
  evidenceEnd: null,
  gapReason,
});

/**
 * The hallucination defense: a value is kept only if its evidence appears in parsedText and the value
 * appears in its evidence (both ignoring whitespace differences). Kept evidence is the original slice,
 * so parsedText.slice(start, end) === evidence.
 */
export function validateEvidence(parsedText: string, expected: ExpectedField[], llmFields: LlmField[]): EvidenceResult {
  const doc = normalize(parsedText);
  const byKey = new Map<string, LlmField>();
  for (const f of llmFields) if (!byKey.has(f.key)) byKey.set(f.key, f);
  const expectedKeys = new Set(expected.map((f) => f.field));

  const values = expected.map(({ field }): ValidatedValue => {
    const f = byKey.get(field);
    if (!f) return gap(field, "missing_from_llm_output");
    if (f.value === null) return gap(field, f.reason?.trim() || "not_found");
    const quote = f.evidence === null ? "" : normalize(f.evidence).text;
    if (!quote) return gap(field, "evidence_not_found");
    if (quote.length < MIN_QUOTE_LENGTH) return gap(field, "evidence_too_short");
    // A quote that appears more than once is still accepted; the first match is stored and highlighted.
    const at = doc.text.indexOf(quote);
    if (at < 0) return gap(field, "evidence_not_found");
    // The prompt asks for the value as the document states it, so a true quote contains it; the model's
    // claimed value and quote stay in the run's raw_response for the reviewer.
    if (!quote.includes(norm(f.value))) return gap(field, "value_not_in_evidence");
    // Quote and document are trimmed, so both ends of the match are non-space characters.
    const start = doc.map[at]!;
    const end = doc.map[at + quote.length - 1]! + 1;
    return { fieldKey: field, value: f.value, evidence: parsedText.slice(start, end), evidenceStart: start, evidenceEnd: end, gapReason: null };
  });

  const dropped = [...new Set(llmFields.map((f) => f.key).filter((k) => !expectedKeys.has(k)))];
  return { values, dropped };
}
