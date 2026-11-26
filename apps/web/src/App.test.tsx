import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";

describe("App", () => {
  it("renders the counter", () => {
    expect(renderToString(<App />)).toContain("Count is");
  });
});
