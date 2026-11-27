import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { HealthView } from "./App.tsx";

describe("App", () => {
  it("shows a loading state before /health answers", () => {
    expect(renderToString(<App />)).toContain("Checking...");
  });
  it("shows each service status", () => {
    const html = renderToString(<HealthView health={{ db: "ok", redis: "error" }} />);
    expect(html).toContain('<dt>db</dt><dd class="ok">ok</dd>');
    expect(html).toContain('<dt>redis</dt><dd class="error">error</dd>');
  });
});
