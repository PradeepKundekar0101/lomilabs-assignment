import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { HealthView } from "./App.tsx";

describe("App", () => {
  it("shows a loading state before /health answers", () => {
    expect(renderToString(<App />)).toContain("Checking...");
  });
  it("shows each service status, and counts only for a service that is up", () => {
    const html = renderToString(
      <HealthView health={{ db: "ok", redis: "error", versions: { queued: 1, extracted: 3 }, queue: null }} />,
    );
    expect(html).toContain('<dt>db</dt><dd class="ok">ok</dd>');
    expect(html).toContain('<dt>redis</dt><dd class="error">error</dd>');
    expect(html).toContain("<h2>Versions</h2><dl><div><dt>queued</dt><dd>1</dd></div><div><dt>extracted</dt><dd>3</dd></div></dl>");
    expect(html).not.toContain("Queue");
  });
});
