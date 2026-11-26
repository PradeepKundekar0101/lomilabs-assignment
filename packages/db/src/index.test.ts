import { describe, expect, it } from "vitest";
import type { Job } from "@lomi/shared";
import { JobStore } from "./index.js";

const job = (id: string): Job => ({ id, type: "t", payload: null, status: "queued", createdAt: new Date() });

describe("JobStore", () => {
  it("returns queued jobs in insertion order", () => {
    const store = new JobStore();
    store.save(job("a"));
    store.save(job("b"));
    store.setStatus("a", "done");
    expect(store.nextQueued()?.id).toBe("b");
  });
  it("throws on unknown id", () => {
    expect(() => new JobStore().setStatus("x", "done")).toThrow("Job x not found");
  });
});
