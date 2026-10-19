import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { signRequest } from "../src/signature";
import fixture from "./fixtures/engine-test-key.json";

const PROTOCOL = "1.1";

async function enginePrivateKey(): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(fixture.private_key_pkcs8_b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "Ed25519" }, false, ["sign"]);
}

describe("GET /v1/meta", () => {
  it("refuses an unsigned request with a structured unauthorized error", async () => {
    const res = await SELF.fetch("https://outpost.test.invalid/v1/meta");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.retryable).toBe(false);
  });

  it("describes the outpost to a request signed by a known engine key", async () => {
    const req = await signRequest(new Request("https://outpost.test.invalid/v1/meta"), {
      keyId: fixture.key_id,
      privateKey: await enginePrivateKey(),
      protocol: PROTOCOL,
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.protocol).toBe(PROTOCOL);
    expect(typeof meta.outpost_version).toBe("string");
    expect(meta.engine_key_ids).toEqual([fixture.key_id]);
    expect(meta.schema_version).toBeNull();
    expect(meta.instances).toEqual([
      { id: "inst-sp", module: "sharepoint", kind: "source", scope: { site: "contoso.sharepoint.com,site-id" }, audience: "everyone", credential: "graph-main" },
      { id: "docs-main", module: "markdown-folder", kind: "source", scope: { prefix: "", description: "the company documentation: services, client procedures, support, tools" }, audience: "everyone", credential: "docs-public" },
      { id: "docs-directors", module: "markdown-folder", kind: "source", scope: { prefix: "directors/", description: "director-only notes: pricing, discounts, finance, hiring" }, audience: ["directors"], credential: "docs-public" },
    ]);
    expect(meta.door_kinds).toEqual([]);
    expect(meta.credential_types).toEqual(["static_header", "oauth2_client_credentials", "hmac_key", "none"]);
    expect(meta.region_hint).toBe("enam");
    expect(meta.limits).toMatchObject({ store_body_bytes: 1_048_576 });
  });
});
