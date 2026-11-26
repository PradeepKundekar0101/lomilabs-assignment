import { describe, expect, it } from "vitest";
import { createJob } from "@lomi/core";
import { JobStore } from "@lomi/db";
import { processNext } from "./index.js";

describe("processNext", () => {
  it("marks handled jobs done and unhandled jobs failed", async () => {
    const store = new JobStore();
    const ok = store.save(createJob("ok", null));
    const bad = store.save(createJob("missing", null));
    await processNext(store, { ok: () => {} });
    await processNext(store, { ok: () => {} });
    expect(store.get(ok.id)?.status).toBe("done");
    expect(store.get(bad.id)?.status).toBe("failed");
  });
});
