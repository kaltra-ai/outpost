import { SELF } from "cloudflare:test";
import { signRequest } from "../src/signature";
import fixture from "./fixtures/engine-test-key.json";

export const PROTOCOL = "1.1";
export const BASE = "https://outpost.test.invalid";

let cachedKey: CryptoKey | undefined;
export async function enginePrivateKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const bytes = Uint8Array.from(atob(fixture.private_key_pkcs8_b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey("pkcs8", bytes, { name: "Ed25519" }, false, ["sign"]);
  return cachedKey;
}

export async function signed(path: string, init: { method?: string; body?: unknown; nonce?: string; now?: number } = {}): Promise<Request> {
  const req = new Request(BASE + path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return signRequest(req, { keyId: fixture.key_id, privateKey: await enginePrivateKey(), protocol: PROTOCOL, nonce: init.nonce, now: init.now });
}

export async function call(path: string, init: { method?: string; body?: unknown; nonce?: string; now?: number } = {}) {
  const res = await SELF.fetch(await signed(path, init));
  const json = (await res.json()) as Record<string, unknown> & { error?: { code: string } };
  return { status: res.status, json };
}

export async function migrateTo(version: number, expected: number | null, statements: string[], key = `mig-${version}-${crypto.randomUUID()}`) {
  return call("/v1/store/migrate", {
    method: "POST",
    body: { request_id: crypto.randomUUID(), idempotency_key: key, expected_schema_version: expected, target_schema_version: version, statements },
  });
}

/** Signs a request whose body is sent raw (proxy routes), with extra headers included as given. */
export async function callRaw(path: string, init: { method?: string; body?: string; headers?: Record<string, string> }) {
  const req = new Request(BASE + path, { method: init.method ?? "POST", headers: init.headers ?? {}, body: init.body });
  const signedReq = await signRequest(req, { keyId: fixture.key_id, privateKey: await enginePrivateKey(), protocol: PROTOCOL });
  return SELF.fetch(signedReq);
}
