import { describe, expect, it } from "vitest";
import { createId } from "./index.js";

describe("createId", () => {
  it("prefixes and is unique", () => {
    const a = createId("job");
    expect(a).toMatch(/^job_[0-9a-f-]{36}$/);
    expect(createId("job")).not.toBe(a);
  });
});
