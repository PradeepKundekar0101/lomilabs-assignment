import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp, type HealthChecks } from "./app.js";
import type { UploadInput } from "./upload.js";

async function getHealth(checks: HealthChecks) {
  const server = createApp({ checks, upload: async () => ({ documentId: "d", versionId: "v" }) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const ok = async () => {};
const fail = async () => {
  throw new Error("down");
};

describe("GET /health", () => {
  it("returns 200 when db and redis are up", async () => {
    expect(await getHealth({ db: ok, redis: ok })).toEqual({ status: 200, body: { db: "ok", redis: "ok" } });
  });
  it("returns 503 when either is down", async () => {
    expect(await getHealth({ db: fail, redis: ok })).toEqual({ status: 503, body: { db: "error", redis: "ok" } });
    expect(await getHealth({ db: ok, redis: fail })).toEqual({ status: 503, body: { db: "ok", redis: "error" } });
  });
});

describe("POST /documents", () => {
  async function post(query: string, body: string, contentType = "application/pdf") {
    const received: UploadInput[] = [];
    const server = createApp({
      checks: { db: ok, redis: ok },
      upload: async (input) => (received.push(input), { documentId: "d", versionId: "v" }),
    }).listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/documents?${query}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
      return { status: res.status, body: await res.json(), received };
    } finally {
      server.close();
    }
  }

  it("passes a valid PDF to upload and returns 201", async () => {
    const r = await post("type=lease&title=%20Unit%204%20", "%PDF-1.4 x");
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ documentId: "d", versionId: "v" });
    expect(r.received[0]).toMatchObject({ type: "lease", title: "Unit 4" });
  });

  it("rejects bad input before calling upload", async () => {
    expect((await post("type=memo&title=x", "%PDF-")).status).toBe(400);
    expect((await post("type=invoice", "%PDF-")).status).toBe(400);
    expect((await post("type=invoice&title=x", "hello")).status).toBe(400);
    expect((await post("type=invoice&title=x", "%PDF-", "text/plain")).status).toBe(415);
    expect((await post("type=invoice&title=x", "hello")).received).toEqual([]);
  });
});
