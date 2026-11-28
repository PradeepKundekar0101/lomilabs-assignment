import type { ExpectedField, ValidatedValue } from "@lomi/core";
import { describe, expect, it } from "vitest";
import { addTallies, checkCarryOver, costUsd, labelProblems, p50, sameValue, scoreDoc, type DocCase, type Run } from "../src/score.ts";

describe("sameValue", () => {
  it.each([
    ["money", "$5,230.29", "5230.29", true],
    ["money", "$5,230.29", "$5,230.30", false],
    ["percent", "4.2%", "4.2", true],
    ["number", "twenty-four (24)", "24", true],
    ["date", "March 1, 2025", "2025-03-01", true],
    ["date", "2025-10-14", "2025-11-13", false],
    ["string", "MERIDIAN  OFFICE\nSUPPLIES", "Meridian Office Supplies", true],
    ["string", "Meridian Office Supplies", "Meridian Office Supplies LLC", false],
    ["money", "n/a", "N/A", true],
  ])("%s %j vs %j is %s", (type, a, b, same) => {
    expect(sameValue(type, a, b)).toBe(same);
  });

  it("treats null as equal only to null", () => {
    expect(sameValue("string", null, null)).toBe(true);
    expect(sameValue("string", null, "x")).toBe(false);
    expect(sameValue("string", "x", null)).toBe(false);
  });
});

const fields: ExpectedField[] = [
  { field: "total", type: "money" },
  { field: "due", type: "date" },
  { field: "income", type: "money" },
];

describe("labelProblems", () => {
  it("accepts a confirmed label with exactly the type's fields", () => {
    const label = { confirmed: true, fields: { total: { expected: "1" }, due: { expected: "2025-01-01" }, income: { expected: null } } };
    expect(labelProblems("doc-v1", label, fields)).toEqual([]);
  });

  it("names an unconfirmed label and missing or extra fields", () => {
    const label = { confirmed: false, fields: { total: { expected: "1" }, extra: { expected: null } } };
    expect(labelProblems("doc-v1", label, fields)).toEqual([
      "doc-v1: not confirmed",
      "doc-v1: missing field due",
      "doc-v1: missing field income",
      "doc-v1: unexpected field extra",
    ]);
  });
});

const value = (fieldKey: string, v: string | null, evidence = v, gapReason: string | null = null): ValidatedValue => ({
  fieldKey,
  value: v,
  evidence,
  evidenceStart: v === null ? null : 0,
  evidenceEnd: v === null ? null : 1,
  gapReason: v === null ? (gapReason ?? "not_found") : null,
});

const run = (values: ValidatedValue[], said: Record<string, string | null>, ms = 1000): Run => ({
  llm: Object.entries(said).map(([key, v]) => ({ key, value: v, evidence: v, reason: null })),
  values,
  error: null,
  tokensIn: 100,
  tokensOut: 10,
  ms,
});

const failed: Run = { llm: null, values: null, error: "llm_request_failed: 529 overloaded_error", tokensIn: 0, tokensOut: 0, ms: null };

const doc = (runs: Run[]): DocCase => ({
  name: "doc-v1",
  fields,
  label: { confirmed: true, fields: { total: { expected: "$1,000.00" }, due: { expected: "2025-01-31" }, income: { expected: null } } },
  text: "Total: $1,000.00\nDue: 2025-01-31",
  runs,
});

describe("scoreDoc", () => {
  it("counts accuracy, gaps, evidence and agreement, and lists every mismatch", () => {
    const good = run([value("total", "1000.00"), value("due", "2025-01-31"), value("income", null)], { total: "1000.00", due: "2025-01-31", income: null });
    const rejected = run(
      [value("total", null, null, "evidence_not_found"), value("due", "2025-01-31"), value("income", null)],
      { total: "$1,000", due: "2025-01-31", income: null },
      3000,
    );
    const { tally, mismatches } = scoreDoc(doc([good, rejected, failed]));

    expect(tally.field).toEqual({ hits: 3, total: 6 });
    expect(tally.gap).toEqual({ hits: 2, total: 3 });
    expect(tally.evidence).toEqual({ hits: 3, total: 4 });
    expect(tally.agreement).toEqual({ hits: 0, total: 3 });
    expect([tally.tokensIn, tally.tokensOut, tally.ms]).toEqual([200, 20, [1000, 3000]]);
    expect(mismatches).toEqual([
      { doc: "doc-v1", run: 2, field: "total", expected: "$1,000.00", got: 'gap: evidence_not_found, the model said "$1,000"' },
      { doc: "doc-v1", run: 3, field: "*", expected: null, got: "error: llm_request_failed: 529 overloaded_error" },
    ]);
  });

  it("counts a field as agreeing when every run returns the same value", () => {
    const r = run([value("total", "$1,000.00"), value("due", "2025-01-31"), value("income", null)], {});
    const formatted = run([value("total", "1000"), value("due", "January 31, 2025"), value("income", null)], {});
    expect(scoreDoc(doc([r, formatted, r])).tally.agreement).toEqual({ hits: 3, total: 3 });
  });
});

describe("totals", () => {
  it("adds tallies, prices tokens and takes the median latency", () => {
    const { tally } = scoreDoc(doc([run([], {}, 1000), run([], {}, 4000)]));
    const total = addTallies([tally, tally]);
    expect(total.tokensIn).toBe(400);
    expect(total.field.total).toBe(8);
    expect(costUsd("claude-opus-5-5", 1_000_000, 100_000)).toBe(6);
    expect(costUsd("some-other-model", 1, 1)).toBeNull();
    expect(p50(total.ms)).toBe(2500);
    expect(p50([3, 1, 2])).toBe(2);
    expect(p50([])).toBeNull();
  });
});

describe("checkCarryOver", () => {
  const twoFields: ExpectedField[] = [
    { field: "vendor", type: "string" },
    { field: "total", type: "money" },
  ];
  const version = (name: string, total: string, text: string, runs: Run[]): DocCase => ({
    name,
    fields: twoFields,
    label: { confirmed: true, fields: { vendor: { expected: "ACME LLC" }, total: { expected: total } } },
    text,
    runs,
  });
  const v1 = version("doc-v1", "$10", "ACME LLC\nTotal: $10", [run([value("vendor", "ACME LLC"), value("total", "$10")], {})]);

  it("passes when exactly the changed fields lose their review", () => {
    const v2 = version("doc-v2", "$12", "ACME LLC\nTotal: $12", [run([value("vendor", "ACME LLC"), value("total", "$12")], {})]);
    expect(checkCarryOver(v1, v2)).toEqual([
      { from: "doc-v1", to: "doc-v2", run: 1, expectedPending: ["total"], pending: ["total"], pass: true },
    ]);
  });

  it("fails when an unchanged value comes back formatted differently, since carry-over compares with norm() only", () => {
    const v2 = version("doc-v2", "$12", "ACME LLC\nTotal: $12", [run([value("vendor", "Acme LLC", "ACME LLC"), value("total", "$12")], {})]);
    expect(checkCarryOver(v1, v2)[0]).toMatchObject({ pending: ["vendor", "total"], pass: false });
  });

  it("fails a pair where either run failed", () => {
    const v2 = version("doc-v2", "$12", "ACME LLC\nTotal: $12", [failed]);
    expect(checkCarryOver(v1, v2)[0]).toMatchObject({ pending: null, pass: false });
  });
});
