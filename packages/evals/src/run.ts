/**
 * Extraction eval (spec 013): runs the worker's pipeline functions on every labelled fixture PDF with the
 * real model, RUNS times each, and prints and saves accuracy, evidence, agreement, tokens, cost and latency.
 * Run it with `pnpm eval` from the repository root. It calls the paid API; it is not part of the tests.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPrompt,
  createLlm,
  ExpectedFieldsSchema,
  ExtractionError,
  extractPdfText,
  parseLlmOutput,
  validateEvidence,
  type ExpectedField,
  type LlmResponse,
  type Prompt,
} from "@lomi/core";
import { z } from "zod";
import {
  addTallies,
  checkCarryOver,
  costUsd,
  LabelSchema,
  labelProblems,
  p50,
  scoreDoc,
  type DocCase,
  type Label,
  type Ratio,
  type Run,
  type Tally,
} from "./score.ts";

const RUNS = 3;
const pkg = path.resolve(import.meta.dirname, "..");
const root = path.resolve(pkg, "../..");

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  // The same fallback as docker-compose.yml's worker.
  LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
});
const ManifestSchema = z.array(
  z.object({ id: z.string(), type: z.string(), versions: z.array(z.object({ version: z.number(), file: z.string() })) }),
);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = EnvSchema.safeParse(process.env);
if (!env.success) fail(`invalid environment:\n${z.prettifyError(env.error)}`);
const model = env.data.LLM_MODEL;

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8"));
const expectedFields = ExpectedFieldsSchema.parse(await readJson(path.join(root, "fixtures/expected-fields.json")));
const manifest = ManifestSchema.parse(await readJson(path.join(root, "fixtures/documents.json")));

interface Target {
  id: string;
  name: string;
  file: string;
  fields: ExpectedField[];
  label: Label;
}

// Every PDF in the manifest needs a usable label before any model call is made.
const targets: Target[] = [];
const problems: string[] = [];
for (const doc of manifest) {
  for (const { version, file } of doc.versions) {
    const name = `${doc.id}-v${version}`;
    const fields = expectedFields[doc.type];
    if (!fields) {
      problems.push(`${name}: unknown document type ${doc.type}`);
      continue;
    }
    let json: unknown;
    try {
      json = await readJson(path.join(pkg, "labels", `${name}.json`));
    } catch (err) {
      problems.push(`${name}: ${(err as Error).message}`);
      continue;
    }
    const label = LabelSchema.safeParse(json);
    if (!label.success) {
      problems.push(`${name}: ${z.prettifyError(label.error)}`);
      continue;
    }
    problems.push(...labelProblems(name, label.data, fields));
    targets.push({ id: doc.id, name, file: path.join(root, "fixtures", file), fields, label: label.data });
  }
}
if (problems.length) fail(`labels are not ready, so nothing was run:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

const llm = createLlm(model);

/** The worker's steps after parsing: call, parse the output, validate the evidence. */
async function runOnce(prompt: Prompt, text: string, fields: ExpectedField[]): Promise<Run> {
  const describe = (err: unknown) => {
    if (err instanceof ExtractionError) return `${err.code}: ${err.message}`;
    throw err;
  };
  const started = performance.now();
  let response: LlmResponse;
  try {
    response = await llm(prompt);
  } catch (err) {
    return { llm: null, values: null, error: describe(err), tokensIn: 0, tokensOut: 0, ms: null };
  }
  const usage = { tokensIn: response.tokensIn, tokensOut: response.tokensOut, ms: Math.round(performance.now() - started) };
  try {
    const llmFields = parseLlmOutput(response);
    return { llm: llmFields, values: validateEvidence(text, fields, llmFields).values, error: null, ...usage };
  } catch (err) {
    return { llm: null, values: null, error: describe(err), ...usage };
  }
}

const startedAt = new Date().toISOString();
console.log(`Extraction eval: ${targets.length} documents x ${RUNS} runs on ${model}\n`);
const cases: DocCase[] = [];
for (const t of targets) {
  const text = await extractPdfText(await readFile(t.file));
  const prompt = buildPrompt(t.fields, text);
  const runs: Run[] = [];
  for (let i = 1; i <= RUNS; i++) {
    const run = await runOnce(prompt, text, t.fields);
    console.log(`  ${t.name} run ${i}: ${run.error ?? "ok"}${run.ms === null ? "" : ` (${(run.ms / 1000).toFixed(1)}s)`}`);
    runs.push(run);
  }
  cases.push({ name: t.name, fields: t.fields, label: t.label, text, runs });
}

const scored = cases.map((c) => ({ c, ...scoreDoc(c) }));
const overall = addTallies(scored.map((s) => s.tally));
const carry = targets.flatMap((t, i) => (i > 0 && targets[i - 1]!.id === t.id ? checkCarryOver(cases[i - 1]!, cases[i]!) : []));
const mismatches = scored.flatMap((s) => s.mismatches);
const summarize = (t: Tally) => ({ ...t, costUsd: costUsd(model, t.tokensIn, t.tokensOut), p50Ms: p50(t.ms) });

const pct = (r: Ratio) => (r.total ? `${Math.round((100 * r.hits) / r.total)}% (${r.hits}/${r.total})` : "-");
function row(name: string, t: Tally): string[] {
  const { costUsd: cost, p50Ms } = summarize(t);
  return [
    name,
    pct(t.field),
    pct(t.gap),
    pct(t.evidence),
    String(t.evidence.total - t.evidence.hits),
    pct(t.agreement),
    String(t.tokensIn),
    String(t.tokensOut),
    cost === null ? "n/a" : `$${cost.toFixed(4)}`,
    p50Ms === null ? "-" : `${(p50Ms / 1000).toFixed(1)}s`,
  ];
}
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

const header = ["Document", "Field acc", "Gap acc", "Evidence pass", "Rejected", "Agreement", "Tokens in", "Tokens out", "Cost", "p50"];
console.log(`\n${table([header, ...scored.map((s) => row(s.c.name, s.tally)), row("Overall", overall)])}`);

console.log("\nCarry-over (an approve on every value of the earlier version):");
for (const c of carry) {
  const got = c.pending === null ? "a run failed" : `pending: ${c.pending.join(", ") || "none"}`;
  console.log(`  ${c.from} -> ${c.to} run ${c.run}: ${c.pass ? "PASS" : "FAIL"} (${got}; expected pending: ${c.expectedPending.join(", ") || "none"})`);
}

console.log(`\nMismatches (${mismatches.length}):`);
for (const m of mismatches) console.log(`  ${m.doc} run ${m.run} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);

const out = path.join(pkg, "results", `${startedAt.replaceAll(":", "-")}.json`);
await mkdir(path.dirname(out), { recursive: true });
const result = {
  startedAt,
  model,
  runsPerDocument: RUNS,
  documents: scored.map(({ c, tally }) => ({ name: c.name, metrics: summarize(tally), runs: c.runs })),
  overall: summarize(overall),
  carryOver: carry,
  mismatches,
};
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nResults: ${path.relative(root, out)}`);
