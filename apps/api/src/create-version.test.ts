import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVersion, StorageUnavailableError, type CreateVersionDeps } from "./create-version.js";

const bytes = "%PDF-1.7 test";
const sha = createHash("sha256").update(bytes).digest("hex");
const file = () => new File([bytes], "march.pdf");
const newDoc = { type: "invoice", title: "march.pdf" } as const;

type Step = "put" | "tx" | "enqueue";

function fakeDeps(opts: { fail?: Partial<Record<Step, true>>; existing?: { currentVersionId: string; maxVersionNo: number } } = {}) {
  const calls: string[] = [];
  const versions: Record<string, unknown>[] = [];
  const boom = (step: Step) => {
    if (opts.fail?.[step]) throw new Error(`${step} down`);
  };
  const tx = {
    document: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => (
        calls.push("find document"), { id: where.id, currentVersionId: opts.existing?.currentVersionId ?? null }
      ),
      create: async ({ data }: { data: { id?: string; title: string } }) => (
        calls.push(`insert document "${data.title}"`), { id: data.id ?? "doc-1", currentVersionId: null }
      ),
      update: async ({ data }: { data: { currentVersionId: string } }) => calls.push(`set current ${data.currentVersionId}`),
    },
    documentVersion: {
      aggregate: async () => ({ _max: { versionNo: opts.existing?.maxVersionNo ?? null } }),
      create: async ({ data }: { data: Record<string, unknown> }) => (
        calls.push("insert version"), versions.push(data), { id: "ver-new", status: data.status }
      ),
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => calls.push(`mark ${where.id} ${data.status}`),
    },
  };
  const deps = {
    putObject: async (key: string) => (calls.push(`put ${key}`), boom("put")),
    db: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        calls.push("begin");
        boom("tx");
        const r = await fn(tx);
        calls.push("commit");
        return r;
      },
    },
    enqueue: async (id: string) => (calls.push(`enqueue ${id}`), boom("enqueue")),
  } as unknown as CreateVersionDeps;
  return { deps, calls, versions };
}

describe("createVersion", () => {
  it("puts the object, then inserts a queued version 1 in one transaction, then enqueues", async () => {
    const { deps, calls, versions } = fakeDeps();
    expect(await createVersion(deps, newDoc, file())).toEqual({ documentId: "doc-1", versionId: "ver-new", status: "queued" });
    expect(calls).toEqual([
      `put pdfs/${sha}.pdf`,
      "begin",
      'insert document "march.pdf"',
      "insert version",
      "set current ver-new",
      "commit",
      "enqueue ver-new",
    ]);
    expect(versions[0]).toEqual({
      documentId: "doc-1",
      versionNo: 1,
      status: "queued",
      storageKey: `pdfs/${sha}.pdf`,
      sha256: sha,
      sizeBytes: bytes.length,
      mimeType: "application/pdf",
    });
  });

  it("creates a new document with a chosen id", async () => {
    const { deps, versions } = fakeDeps();
    expect(await createVersion(deps, { ...newDoc, id: "doc-invoice-001" }, file())).toMatchObject({ documentId: "doc-invoice-001" });
    expect(versions[0]).toMatchObject({ documentId: "doc-invoice-001", versionNo: 1 });
  });

  it("touches no rows when object storage is down", async () => {
    const { deps, calls } = fakeDeps({ fail: { put: true } });
    await expect(createVersion(deps, newDoc, file())).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(calls).toEqual([`put pdfs/${sha}.pdf`]);
  });

  it("does not enqueue when the transaction fails", async () => {
    const { deps, calls } = fakeDeps({ fail: { tx: true } });
    await expect(createVersion(deps, newDoc, file())).rejects.toThrow("tx down");
    expect(calls.some((c) => c.startsWith("enqueue"))).toBe(false);
  });

  it("still succeeds with the row queued when Redis is down", async () => {
    const { deps } = fakeDeps({ fail: { enqueue: true } });
    await expect(createVersion(deps, newDoc, file())).resolves.toMatchObject({ status: "queued" });
  });

  it("adds the next version to an existing document and supersedes its current version", async () => {
    const { deps, calls, versions } = fakeDeps({ existing: { currentVersionId: "ver-old", maxVersionNo: 3 } });
    expect(await createVersion(deps, { documentId: "doc-9" }, file())).toMatchObject({ documentId: "doc-9", versionId: "ver-new" });
    expect(versions[0]).toMatchObject({ documentId: "doc-9", versionNo: 4 });
    expect(calls).toEqual([
      `put pdfs/${sha}.pdf`,
      "begin",
      "find document",
      "insert version",
      "mark ver-old superseded",
      "set current ver-new",
      "commit",
      "enqueue ver-new",
    ]);
  });
});
