import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { StorageUnavailableError, VersionRejectedError } from "../src/errors.js";
import type { AppDeps } from "../src/types/app.js";

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
    },
    documentVersion: { findUnique: async () => ({ ...storedDoc.currentVersion, parsedText: "Invoice" }) },
    // The document list's one query, shaped as its SELECT returns it.
    $queryRaw: async () => [{ id: DOC_ID, title: "march.pdf", type: "invoice", versionNo: 1, status: "queued", error: null, total: 0, pending: 0 }],
    extractedValue: { findMany: async () => [] },
    $transaction: fail,
  } as unknown as AppDeps["db"],
  fields: { invoice: [] },
  createVersion: async () => ({ documentId: DOC_ID, versionId: "ver-1", versionNo: 1, status: "queued" }),
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

describe("GET /health/live", () => {
  it("returns 200 even while Postgres and Redis are down", async () => {
    expect(await request("/health/live", {}, { checks: { db: fail, redis: fail } })).toEqual({ status: 200, body: { status: "ok" } });
  });
});

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
    expect(r).toEqual({ status: 202, body: { id: DOC_ID, versionId: "ver-1", versionNo: 1, status: "queued" }, calls: r.calls });
    const [target, file] = r.calls[0]!;
    expect({ target, name: file.name }).toEqual({ target: { type: "lease", title: "march.pdf" }, name: "march.pdf" });
  });

  it("rejects invalid uploads with 400 before calling createVersion", async () => {
    const badType = "type must be one of invoice, lease, market_report";
    const cases: [FormData, string][] = [
      [form("lease", new File(["hello"], "notes.pdf")), "file is not a PDF"],
      [form("memo", pdf()), badType],
      [form(null, pdf()), badType],
      [form("memo", new File(["hello"], "notes.pdf")), badType], // the type is checked first
      [form("lease", null), "file is required"],
      [form("lease", pdf(10 * 1024 * 1024)), "file must be at most 10 MB"], // just over 10 MB
      [form("lease", pdf(11 * 1024 * 1024)), "file must be at most 10 MB"], // over the body cap
    ];
    for (const [body, error] of cases) {
      const r = await upload(body);
      expect(r).toEqual({ status: 400, body: { error }, calls: [] });
    }
  });

  it("rejects a malformed multipart body with 400", async () => {
    const r = await request("/documents", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "not multipart" });
    expect(r).toEqual({ status: 400, body: { error: "malformed multipart body" } });
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

describe("POST /documents/:id/versions", () => {
  const pdf = (size = 0) => new File(["%PDF-1.7 ", new Uint8Array(size)], "march-v2.pdf", { type: "application/pdf" });
  function form(file: File | null) {
    const body = new FormData();
    if (file) body.append("file", file);
    return body;
  }

  async function uploadVersion(body: FormData | string, createVersion: AppDeps["createVersion"] = baseDeps.createVersion) {
    const calls: Parameters<AppDeps["createVersion"]>[] = [];
    const res = await request(`/documents/${DOC_ID}/versions`, { method: "POST", body }, { createVersion: async (...args) => (calls.push(args), createVersion(...args)) });
    return { ...res, calls };
  }
  const rejected = (reason: VersionRejectedError["reason"]) => async () => {
    throw new VersionRejectedError(reason);
  };

  it("returns 202 with the new version's number and passes the document id to createVersion", async () => {
    const r = await uploadVersion(form(pdf()), async () => ({ documentId: DOC_ID, versionId: "ver-2", versionNo: 2, status: "queued" }));
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ id: DOC_ID, versionId: "ver-2", versionNo: 2, status: "queued" });
    const [target, file] = r.calls[0]!;
    expect({ target, name: file.name }).toEqual({ target: { documentId: DOC_ID }, name: "march-v2.pdf" });
  });

  it("rejects invalid files with 400 before calling createVersion, as the upload does", async () => {
    for (const body of [form(new File(["hello"], "notes.pdf")), form(null), form(pdf(10 * 1024 * 1024)), form(pdf(11 * 1024 * 1024))]) {
      const r = await uploadVersion(body);
      expect(r.status).toBe(400);
      expect(r.calls).toEqual([]);
    }
    const r = await request(`/documents/${DOC_ID}/versions`, { method: "POST", headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" });
    expect(r.status).toBe(415);
  });

  it("returns 404 for an unknown document and 409 for the same bytes as the current version", async () => {
    expect(await uploadVersion(form(pdf()), rejected("document_not_found"))).toMatchObject({ status: 404, body: { error: "document not found" } });
    expect(await uploadVersion(form(pdf()), rejected("identical_to_current"))).toMatchObject({ status: 409, body: { error: "identical_to_current" } });
  });

  it("returns 503 when object storage is down", async () => {
    const r = await uploadVersion(form(pdf()), async () => {
      throw new StorageUnavailableError(new Error("ECONNREFUSED"));
    });
    expect(r.status).toBe(503);
  });
});

describe("GET /documents/:id", () => {
  it("returns the document, its current version and that version's values", async () => {
    const currentVersion = { id: "ver-1", versionNo: 1, status: "queued", error: null, attempts: 0, createdAt: "2026-11-27T10:00:00.000Z" };
    expect(await request(`/documents/${DOC_ID}`)).toEqual({
      status: 200,
      body: {
        id: DOC_ID,
        title: "march.pdf",
        type: "invoice",
        createdAt: "2026-11-27T10:00:00.000Z",
        currentVersion,
        version: { ...currentVersion, parsedText: "Invoice" },
        values: [],
      },
    });
  });

  it("returns 404 for an unknown id", async () => {
    expect((await request("/documents/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await request("/documents/doc-missing-001")).status).toBe(404);
  });
});

describe("POST /values/:id/review", () => {
  const VALUE_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const post = (body: string, contentType = "application/json") =>
    request(`/values/${VALUE_ID}/review`, { method: "POST", headers: { "content-type": contentType }, body });

  it("rejects an invalid body with 400 before touching the database", async () => {
    const cases = [
      { action: "correct" }, // no correctedValue
      { action: "correct", correctedValue: "   " }, // blank after trimming
      { action: "correct", correctedValue: 5230.29 },
      { action: "approve", correctedValue: "x" }, // approve carries no correction
      { action: "approve", note: "x".repeat(1001) },
      { action: "reject" },
      {},
    ];
    for (const body of cases) expect((await post(JSON.stringify(body))).status, JSON.stringify(body)).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post("action=approve", "application/x-www-form-urlencoded")).status).toBe(400);
  });

  it("returns 404 for a value id that is not a uuid", async () => {
    const r = await request("/values/not-a-uuid/review", { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"approve"}' });
    expect(r).toEqual({ status: 404, body: { error: "value not found" } });
  });

  it("answers an oversized JSON body with 413, not the upload's file-size message", async () => {
    const r = await post(JSON.stringify({ action: "approve", note: "x".repeat(200 * 1024) }));
    expect(r.status).toBe(413);
    expect(r.body.error).not.toMatch(/file/);
  });

  it("accepts a note of exactly 1000 characters", async () => {
    // The fake database fails the transaction: getting past validation is what is checked here.
    expect((await post(JSON.stringify({ action: "approve", note: "x".repeat(1000) }))).status).toBe(500);
  });
});

describe("GET /documents", () => {
  it("lists documents with their current version, its error and its review counts", async () => {
    expect(await request("/documents")).toEqual({
      status: 200,
      body: [{ id: DOC_ID, title: "march.pdf", type: "invoice", versionNo: 1, status: "queued", error: null, total: 0, pending: 0 }],
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

describe("CORS for the review UI on another origin", () => {
  const WEB = "https://lomi.vercel.app";
  async function headers(path: string, init: RequestInit, webOrigin?: string) {
    const server = createApp({ ...baseDeps, webOrigin }).listen(0);
    await once(server, "listening");
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init);
      return { status: res.status, allow: res.headers.get("access-control-allow-origin"), methods: res.headers.get("access-control-allow-methods") };
    } finally {
      server.close();
    }
  }
  const preflight = { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } };

  it("allows WEB_ORIGIN's requests and answers its preflight", async () => {
    expect(await headers("/documents", { headers: { origin: WEB } }, WEB)).toEqual({ status: 200, allow: WEB, methods: null });
    expect(await headers("/values/x/review", preflight, WEB)).toEqual({ status: 204, allow: WEB, methods: "GET, POST" });
  });
  it("sends no CORS headers to another origin, or when WEB_ORIGIN is unset", async () => {
    expect((await headers("/documents", { headers: { origin: "https://evil.example" } }, WEB)).allow).toBeNull();
    expect((await headers("/values/x/review", preflight)).allow).toBeNull();
  });
});
