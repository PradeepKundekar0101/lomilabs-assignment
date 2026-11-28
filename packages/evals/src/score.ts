import { carryOver, norm, type ExpectedField, type LlmField, type ValidatedValue } from "@lomi/core";
import { z } from "zod";

/** packages/evals/labels/<doc-id>-v<n>.json: the expected value of each field; null means it must be a gap. */
export const LabelSchema = z.strictObject({
  confirmed: z.boolean(),
  fields: z.record(z.string(), z.strictObject({ expected: z.string().nullable() })),
});
export type Label = z.infer<typeof LabelSchema>;

/** Why a label cannot be used yet: unconfirmed, or its fields differ from the document type's. */
export function labelProblems(name: string, label: Label, fields: ExpectedField[]): string[] {
  const want = new Set(fields.map((f) => f.field));
  return [
    ...(label.confirmed ? [] : [`${name}: not confirmed`]),
    ...[...want].filter((f) => !Object.hasOwn(label.fields, f)).map((f) => `${name}: missing field ${f}`),
    ...Object.keys(label.fields).filter((f) => !want.has(f)).map((f) => `${name}: unexpected field ${f}`),
  ];
}

const asText = (s: string) => norm(s).toLowerCase();

const asNumber = (s: string) => {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s);
  return m ? Number(m[0].replaceAll(",", "")) : null;
};

// shortcut: non-ISO dates go through Date's own parser (fine for "March 1, 2025"); use a real date parser if labels need other formats.
const asIsoDate = (s: string) => {
  const t = norm(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The eval's notion of "the same value" (spec 013, option B): numbers for money, number and percent,
 * ISO dates for dates, otherwise whitespace-collapsed and case-insensitive. A side that does not parse
 * as its type is compared as text. Carry-over does not use this; it compares with norm() only.
 */
export function sameValue(type: string, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const parse = type === "date" ? asIsoDate : ["money", "number", "percent"].includes(type) ? asNumber : null;
  const [x, y] = parse ? [parse(a), parse(b)] : [null, null];
  return x !== null && y !== null ? x === y : asText(a) === asText(b);
}

/** One pass of the pipeline over one PDF; `llm` and `values` are null when the call or the parse threw. */
export interface Run {
  llm: LlmField[] | null;
  values: ValidatedValue[] | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Wall time of the model call; null when the call itself failed. */
  ms: number | null;
}

/** One labelled PDF and its runs. */
export interface DocCase {
  name: string;
  fields: ExpectedField[];
  label: Label;
  text: string;
  runs: Run[];
}

export interface Ratio {
  hits: number;
  total: number;
}

export interface Tally {
  field: Ratio;
  gap: Ratio;
  /** Of the values the model returned, how many kept their evidence; total - hits are the rejections. */
  evidence: Ratio;
  agreement: Ratio;
  tokensIn: number;
  tokensOut: number;
  ms: number[];
}

export interface Mismatch {
  doc: string;
  run: number;
  field: string;
  expected: string | null;
  got: string;
}

const tick = (r: Ratio, hit: boolean) => {
  r.total++;
  if (hit) r.hits++;
};

/** What a field came back as, for the mismatch list. */
function describe(v: ValidatedValue, said: string | null): string {
  if (v.value !== null) return v.value;
  return said === null ? `gap: ${v.gapReason}` : `gap: ${v.gapReason}, the model said "${said}"`;
}

export function scoreDoc(c: DocCase): { tally: Tally; mismatches: Mismatch[] } {
  const tally: Tally = {
    field: { hits: 0, total: 0 },
    gap: { hits: 0, total: 0 },
    evidence: { hits: 0, total: 0 },
    agreement: { hits: 0, total: 0 },
    tokensIn: 0,
    tokensOut: 0,
    ms: [],
  };
  const mismatches: Mismatch[] = [];
  const valueOf = (run: Run, key: string) => run.values?.find((v) => v.fieldKey === key);

  c.runs.forEach((run, i) => {
    tally.tokensIn += run.tokensIn;
    tally.tokensOut += run.tokensOut;
    if (run.ms !== null) tally.ms.push(run.ms);
    if (run.error !== null) mismatches.push({ doc: c.name, run: i + 1, field: "*", expected: null, got: `error: ${run.error}` });
    for (const { field, type } of c.fields) {
      const expected = c.label.fields[field]!.expected;
      const v = valueOf(run, field);
      // validateEvidence uses the first entry for a key, so this is the value it checked.
      const said = run.llm?.find((f) => f.key === field)?.value ?? null;
      if (v && said !== null) tick(tally.evidence, v.value !== null);
      const hit = v !== undefined && sameValue(type, expected, v.value);
      tick(expected === null ? tally.gap : tally.field, hit);
      if (v && !hit) mismatches.push({ doc: c.name, run: i + 1, field, expected, got: describe(v, said) });
    }
  });

  for (const { field, type } of c.fields) {
    const values = c.runs.map((run) => valueOf(run, field));
    tick(tally.agreement, values.every((v) => v !== undefined && sameValue(type, values[0]!.value, v.value)));
  }
  return { tally, mismatches };
}

export function addTallies(tallies: Tally[]): Tally {
  const sum = (pick: (t: Tally) => Ratio) => ({
    hits: tallies.reduce((n, t) => n + pick(t).hits, 0),
    total: tallies.reduce((n, t) => n + pick(t).total, 0),
  });
  return {
    field: sum((t) => t.field),
    gap: sum((t) => t.gap),
    evidence: sum((t) => t.evidence),
    agreement: sum((t) => t.agreement),
    tokensIn: tallies.reduce((n, t) => n + t.tokensIn, 0),
    tokensOut: tallies.reduce((n, t) => n + t.tokensOut, 0),
    ms: tallies.flatMap((t) => t.ms),
  };
}

// shortcut: list prices of the requested model only; a refusal fallback served by another model is priced as the requested one. Add a model here when the eval runs on it.
const PRICES_PER_MTOK: Record<string, { in: number; out: number }> = { "claude-opus-5-5": { in: 4, out: 20 } };

export function costUsd(model: string, tokensIn: number, tokensOut: number): number | null {
  const price = PRICES_PER_MTOK[model];
  return price ? (tokensIn * price.in + tokensOut * price.out) / 1e6 : null;
}

export function p50(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface CarryOverCheck {
  from: string;
  to: string;
  run: number;
  /** Fields whose labels differ between the two versions: the ones that must lose their review. */
  expectedPending: string[];
  /** Fields carryOver left pending; null when either run failed. */
  pending: string[] | null;
  pass: boolean;
}

/**
 * Carries a synthetic approve review on every value of `prev` run i onto `next` run i, as the worker
 * does when a new version is extracted, and checks that exactly the fields whose labels changed lose it.
 */
export function checkCarryOver(prev: DocCase, next: DocCase): CarryOverCheck[] {
  const expectedPending = next.fields
    .filter(({ field, type }) => !sameValue(type, prev.label.fields[field]!.expected, next.label.fields[field]!.expected))
    .map((f) => f.field);
  return next.runs.map((run, i) => {
    const base = prev.runs[i]?.values;
    const check = { from: prev.name, to: next.name, run: i + 1, expectedPending };
    if (!base || !run.values) return { ...check, pending: null, pass: false };
    const results = carryOver(
      base.map((v) => ({
        id: v.fieldKey,
        fieldKey: v.fieldKey,
        value: v.value,
        evidence: v.evidence,
        latestReview: { id: `review-${v.fieldKey}`, action: "approve" as const, correctedValue: null, note: null },
      })),
      run.values,
      next.text,
    );
    const pending = run.values.filter((_, j) => results[j]!.reviewStatus === "pending").map((v) => v.fieldKey);
    return { ...check, pending, pass: pending.join() === expectedPending.join() };
  });
}
