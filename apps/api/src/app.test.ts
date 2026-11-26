import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp, type HealthChecks } from "./app.js";

async function getHealth(checks: HealthChecks) {
  const server = createApp(checks).listen(0);
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
