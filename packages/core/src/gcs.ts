const METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const API = "https://storage.googleapis.com";

/** The Cloud Run service account's access token, from the metadata server: no key exists to leak or rotate. */
async function token(): Promise<string> {
  const res = await fetch(METADATA_TOKEN, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata server token: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`cloud storage ${what}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

/**
 * Objects in one Cloud Storage bucket through the JSON API, as the service account the code runs as.
 * The S3 API would need an HMAC key, a service account key that organization policies often forbid.
 */
export function gcsBucket(bucket: string) {
  return {
    put: async (key: string, body: Uint8Array, contentType: string): Promise<void> => {
      const url = `${API}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(key)}`;
      // A copy: fetch's types reject a Node Buffer as a body.
      const init = { method: "POST", headers: { authorization: `Bearer ${await token()}`, "content-type": contentType }, body: new Uint8Array(body) };
      await ok(await fetch(url, init), `upload of ${key}`);
    },
    get: async (key: string): Promise<Uint8Array> => {
      const res = await fetch(`${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?alt=media`, { headers: { authorization: `Bearer ${await token()}` } });
      return new Uint8Array(await (await ok(res, `download of ${key}`)).arrayBuffer());
    },
  };
}
