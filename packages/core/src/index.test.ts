import { describe, expect, it } from "vitest";
import { createJob } from "./index.js";

describe("createJob", () => {
  it("creates a queued job", () => {
    const job = createJob("email", { to: "a@b.c" });
    expect(job).toMatchObject({ type: "email", status: "queued" });
  });
  it("rejects an empty type", () => {
    expect(() => createJob(" ", {})).toThrow("Job type is required");
  });
});
