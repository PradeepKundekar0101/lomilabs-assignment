import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import { StorageUnavailableError } from "./create-version.js";

const fail = async () => {
  throw new Error("down");
};
const versions = { queued: 1, extracting: 0, extracted: 3, failed: 0, superseded: 0 };
const queue = { waiting: 1, active: 0 };
const counts = { db: async () => versions, redis: async () => queue };

const DOC_ID = "8f0c2c1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const storedDoc = {
  id: DOC_ID,
  title: "march.pdf",
  type: "invoice",
  createdAt: new Date("2026-11-27T10:00:00Z"),
  currentVersion: { id: "ver-1", versionNo: 1, status: "queued", error: null, attempts: 0, createdAt: new Date("2026-11-27T10:00:00Z") },
};

const baseDeps: AppDeps = {
  checks: counts,
  db: {
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === DOC_ID ? storedDoc : null),
      // Shaped like the route's select, as Prisma would return it.
      findMany: async () => [{ id: DOC_ID, title: "march.pdf", type: "invoice", currentVersion: { versionNo: 1, status: "queued" } }],
    },
  } as unknown as AppDeps["db"],
  createVersion: async () => ({ documentId: DOC_ID, versionId: "ver-1", status: "queued" }),
  retry: async () => ({ versionId: "ver-1" }),
};

async function request(path: string, init: RequestInit = {}, deps: Partial<AppDeps> = {}) {
  const server = createApp({ ...baseDeps, ...deps }).listen(0);
  await once(server, "listening");
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe("GET /health", () => {
  it("returns 200 with version and queue counts when db and redis are up", async () => {
    expect(await request("/health")).toEqual({ status: 200, body: { db: "ok", redis: "ok", versions, queue } });
  });
  it("returns 503, with null counts for the service that is down", async () => {
    expect(await request("/health", {}, { checks: { ...counts, db: fail } })).toEqual({
      status: 503,
      body: { db: "error", redis: "ok", versions: null, queue },
    });
    expect(await request("/health", {}, { checks: { ...counts, redis: fail } })).toEqual({
      status: 503,
      body: { db: "ok", redis: "error", versions, queue: null },
    });
  });
});

describe("POST /documents", () => {
  function form(type: string | null, file: File | null) {
    const body = new FormData();
    if (type !== null) body.append("type", type);
    if (file) body.append("file", file);
    return body;
  }
  const pdf = (size = 0) => new File(["%PDF-1.7 ", new Uint8Array(size)], "march.pdf", { type: "application/pdf" });

  async function upload(body: FormData | string, createVersion: AppDeps["createVersion"] = baseDeps.createVersion) {
    const calls: Parameters<AppDeps["createVersion"]>[] = [];
    const res = await request("/documents", { method: "POST", body }, { createVersion: async (...args) => (calls.push(args), createVersion(...args)) });
    return { ...res, calls };
  }

  it("returns 202 with the queued version and passes the file to createVersion", async () => {
    const r = await upload(form("lease", pdf()));
    expect(r).toMatchObject({ status: 202, body: { id: DOC_ID, versionId: "ver-1", status: "queued" } });
    const [target, file] = r.calls[0]!;
    expect({ target, name: file.name }).toEqual({ target: { type: "lease", title: "march.pdf" }, name: "march.pdf" });
  });

  it("rejects invalid uploads with 400 before calling createVersion", async () => {
    const cases = [
      form("lease", new File(["hello"], "notes.pdf")), // not a PDF
      form("memo", pdf()), // unknown type
      form(null, pdf()), // missing type
      form("lease", null), // missing file
      form("lease", pdf(10 * 1024 * 1024)), // just over 10 MB
      form("lease", pdf(11 * 1024 * 1024)), // over the body cap
    ];
    for (const body of cases) {
      const r = await upload(body);
      expect(r.status).toBe(400);
      expect(r.calls).toEqual([]);
    }
  });

  it("rejects a body that is not multipart with 415", async () => {
    const r = await request("/documents", { method: "POST", headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" });
    expect(r.status).toBe(415);
  });

  it("returns 503 when object storage is down", async () => {
    const r = await upload(form("invoice", pdf()), async () => {
      throw new StorageUnavailableError(new Error("ECONNREFUSED"));
    });
    expect(r.status).toBe(503);
  });

  it("returns 500 for any other failure", async () => {
    expect((await upload(form("invoice", pdf()), fail as AppDeps["createVersion"])).status).toBe(500);
  });
});

describe("GET /documents/:id", () => {
  it("returns the document, its current version and no values", async () => {
    expect(await request(`/documents/${DOC_ID}`)).toEqual({
      status: 200,
      body: {
        id: DOC_ID,
        title: "march.pdf",
        type: "invoice",
        createdAt: "2026-11-27T10:00:00.000Z",
        currentVersion: { id: "ver-1", versionNo: 1, status: "queued", error: null, attempts: 0, createdAt: "2026-11-27T10:00:00.000Z" },
        values: [],
      },
    });
  });

  it("returns 404 for an unknown id", async () => {
    expect((await request("/documents/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await request("/documents/doc-missing-001")).status).toBe(404);
  });
});

describe("GET /documents", () => {
  it("lists documents with their current version number and status", async () => {
    expect(await request("/documents")).toEqual({
      status: 200,
      body: [{ id: DOC_ID, title: "march.pdf", type: "invoice", versionNo: 1, status: "queued" }],
    });
  });
});

describe("POST /documents/:id/retry", () => {
  const retry = (result: Awaited<ReturnType<AppDeps["retry"]>>) => request(`/documents/${DOC_ID}/retry`, { method: "POST" }, { retry: async () => result });

  it("returns 202 with the requeued version", async () => {
    expect(await retry({ versionId: "ver-1" })).toEqual({ status: 202, body: { id: DOC_ID, versionId: "ver-1", status: "queued" } });
  });
  it("returns 409 unless the current version failed, and 404 for an unknown document", async () => {
    expect((await retry("not_failed")).status).toBe(409);
    expect((await retry("not_found")).status).toBe(404);
  });
  it("returns 500 when the database fails", async () => {
    const r = await request(`/documents/${DOC_ID}/retry`, { method: "POST" }, { retry: fail as AppDeps["retry"] });
    expect(r).toEqual({ status: 500, body: { error: "internal error" } });
  });
});
