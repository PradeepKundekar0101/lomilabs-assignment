import { describe, expect, it } from "vitest";
import { JobStore } from "@lomi/db";
import { enqueue } from "./index.js";

describe("enqueue", () => {
  it("stores a new job", () => {
    const store = new JobStore();
    const job = enqueue(store, { type: "email", payload: 1 });
    expect(store.get(job.id)).toBe(job);
  });
  it("validates the body", () => {
    expect(() => enqueue(new JobStore(), { type: 5 })).toThrow("type must be a string");
  });
});
