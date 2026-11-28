import { afterEach, describe, expect, it, vi } from "vitest";
import { gcsBucket } from "../src/gcs.js";

type Call = { url: string; init?: RequestInit };

/** Answers the metadata server with a token and Cloud Storage with `storage`, recording every request. */
function stubFetch(storage: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url.startsWith("http://metadata.google.internal") ? Response.json({ access_token: "tok" }) : storage();
  });
  return calls;
}

afterEach(() => void vi.unstubAllGlobals());

describe("gcsBucket", () => {
  it("uploads with the metadata server's token, and the key encoded as the object name", async () => {
    const calls = stubFetch(() => new Response("{}"));
    await gcsBucket("pdfs").put("pdfs/ab.pdf", new Uint8Array([1, 2]), "application/pdf");
    expect(calls[0].init?.headers).toEqual({ "Metadata-Flavor": "Google" });
    expect(calls[1].url).toBe("https://storage.googleapis.com/upload/storage/v1/b/pdfs/o?uploadType=media&name=pdfs%2Fab.pdf");
    expect(calls[1].init?.headers).toEqual({ authorization: "Bearer tok", "content-type": "application/pdf" });
    expect(calls[1].init?.body).toEqual(new Uint8Array([1, 2]));
  });

  it("downloads an object's bytes", async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([7, 8])));
    expect(await gcsBucket("pdfs").get("pdfs/ab.pdf")).toEqual(new Uint8Array([7, 8]));
    expect(calls[1].url).toBe("https://storage.googleapis.com/storage/v1/b/pdfs/o/pdfs%2Fab.pdf?alt=media");
  });

  it("throws with the status and body when Cloud Storage refuses", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    await expect(gcsBucket("pdfs").get("k")).rejects.toThrow("cloud storage download of k: HTTP 403 forbidden");
    await expect(gcsBucket("pdfs").put("k", new Uint8Array(), "application/pdf")).rejects.toThrow(/upload of k: HTTP 403/);
  });
});
