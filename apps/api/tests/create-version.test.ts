import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageUnavailableError, VersionRejectedError } from "../src/errors.js";
import { createVersion } from "../src/services/versions.service.js";
import type { CreateVersionDeps } from "../src/types/versions.js";

const bytes = "%PDF-1.7 test";
const sha = createHash("sha256").update(bytes).digest("hex");
const file = () => new File([bytes], "march.pdf");
const newDoc = { type: "invoice", title: "march.pdf" } as const;

type Step = "put" | "tx" | "enqueue";

/** An existing document's current version's sha256 and highest version number. */
type Existing = { currentSha256: string | null; maxVersionNo: number };

function fakeDeps(opts: { fail?: Partial<Record<Step, true>>; existing?: Existing } = {}) {
  const calls: string[] = [];
  const versions: Record<string, unknown>[] = [];
  const boom = (step: Step) => {
    if (opts.fail?.[step]) throw new Error(`${step} down`);
  };
  const tx = {
    // Only the document lock uses raw SQL; an unknown document has no row.
    $queryRaw: async (sql: TemplateStringsArray, id: string) => {
      calls.push(`lock document ${id}${sql.join("?").includes("FOR UPDATE OF d") ? "" : " WITHOUT LOCK"}`);
      return opts.existing ? [{ id, current_sha256: opts.existing.currentSha256 }] : [];
    },
    document: {
      create: async ({ data }: { data: { id?: string; title: string } }) => (calls.push(`insert document "${data.title}"`), { id: data.id ?? "doc-1" }),
      update: async ({ data }: { data: { currentVersionId: string } }) => calls.push(`set current ${data.currentVersionId}`),
    },
    documentVersion: {
      aggregate: async () => ({ _max: { versionNo: opts.existing?.maxVersionNo ?? null } }),
      create: async ({ data }: { data: Record<string, unknown> }) => (
        calls.push("insert version"), versions.push(data), { id: "ver-new", versionNo: data.versionNo, status: data.status }
      ),
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
    expect(await createVersion(deps, newDoc, file())).toEqual({ documentId: "doc-1", versionId: "ver-new", versionNo: 1, status: "queued" });
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

  it("adds the next version to an existing document under its lock and leaves its previous version alone", async () => {
    const { deps, calls, versions } = fakeDeps({ existing: { currentSha256: "an-older-file", maxVersionNo: 3 } });
    expect(await createVersion(deps, { documentId: "doc-9" }, file())).toEqual({ documentId: "doc-9", versionId: "ver-new", versionNo: 4, status: "queued" });
    expect(versions[0]).toMatchObject({ documentId: "doc-9", versionNo: 4, status: "queued" });
    expect(calls).toEqual([`put pdfs/${sha}.pdf`, "begin", "lock document doc-9", "insert version", "set current ver-new", "commit", "enqueue ver-new"]);
  });

  it("adds a version to a document whose current version was never set", async () => {
    const { deps } = fakeDeps({ existing: { currentSha256: null, maxVersionNo: 0 } });
    expect(await createVersion(deps, { documentId: "doc-9" }, file())).toMatchObject({ versionNo: 1 });
  });

  it("refuses an unknown document and the same bytes as the current version, without writing or enqueueing", async () => {
    for (const [existing, reason] of [
      [undefined, "document_not_found"],
      [{ currentSha256: sha, maxVersionNo: 2 }, "identical_to_current"],
    ] as const) {
      const { deps, calls, versions } = fakeDeps({ existing });
      await expect(createVersion(deps, { documentId: "doc-9" }, file())).rejects.toEqual(new VersionRejectedError(reason));
      expect(versions).toEqual([]);
      expect(calls).toEqual([`put pdfs/${sha}.pdf`, "begin", "lock document doc-9"]);
    }
  });
});
