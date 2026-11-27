import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { uploadDocument, type UploadDeps } from "./upload.js";

const pdf = Buffer.from("%PDF-1.7 test");
const sha = createHash("sha256").update(pdf).digest("hex");

function fakeDeps(overrides: Partial<Record<"put" | "tx" | "enqueue", () => Promise<void>>> = {}) {
  const calls: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const tx = {
    document: {
      create: async ({ data }: { data: object }) => (calls.push("insert document"), { id: "doc-1", ...data }),
      update: async () => calls.push("set current version"),
    },
    documentVersion: {
      create: async ({ data }: { data: Record<string, unknown> }) => (calls.push("insert version"), rows.push(data), { id: "ver-1" }),
    },
  };
  const deps = {
    putObject: async (key: string) => {
      calls.push(`put ${key}`);
      await overrides.put?.();
    },
    db: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        calls.push("begin");
        await overrides.tx?.();
        const r = await fn(tx);
        calls.push("commit");
        return r;
      },
    },
    enqueue: async (id: string) => {
      calls.push(`enqueue ${id}`);
      await overrides.enqueue?.();
    },
  } as unknown as UploadDeps;
  return { deps, calls, rows };
}

const input = { type: "invoice" as const, title: "March", pdf };
const boom = async () => {
  throw new Error("boom");
};

describe("uploadDocument", () => {
  it("puts the object, then inserts rows in one transaction, then enqueues", async () => {
    const { deps, calls, rows } = fakeDeps();
    expect(await uploadDocument(deps, input)).toEqual({ documentId: "doc-1", versionId: "ver-1" });
    expect(calls).toEqual([
      `put pdfs/${sha}.pdf`,
      "begin",
      "insert document",
      "insert version",
      "set current version",
      "commit",
      "enqueue ver-1",
    ]);
    expect(rows[0]).toMatchObject({ storageKey: `pdfs/${sha}.pdf`, sha256: sha, sizeBytes: pdf.length, mimeType: "application/pdf" });
  });

  it("inserts nothing when the object upload fails", async () => {
    const { deps, calls } = fakeDeps({ put: boom });
    await expect(uploadDocument(deps, input)).rejects.toThrow("boom");
    expect(calls).toEqual([`put pdfs/${sha}.pdf`]);
  });

  it("does not enqueue when the transaction fails", async () => {
    const { deps, calls } = fakeDeps({ tx: boom });
    await expect(uploadDocument(deps, input)).rejects.toThrow("boom");
    expect(calls).not.toContain("enqueue ver-1");
  });

  it("still succeeds when enqueue fails, since the row is committed", async () => {
    const { deps } = fakeDeps({ enqueue: boom });
    await expect(uploadDocument(deps, input)).resolves.toEqual({ documentId: "doc-1", versionId: "ver-1" });
  });
});
