import { describe, it, expect } from "vitest";
import { generateSigningKeyPair, signRequest, verifyRequest } from "../src/signature";

const PROTOCOL = "1.1";

async function signedRequest(opts: { body?: string; url?: string; method?: string } = {}) {
  const pair = await generateSigningKeyPair();
  const req = new Request(opts.url ?? "https://outpost.test.invalid/v1/meta?x=1", {
    method: opts.method ?? "GET",
    body: opts.method && opts.method !== "GET" ? (opts.body ?? "") : undefined,
  });
  const signed = await signRequest(req, {
    keyId: "engine-k1",
    privateKey: pair.privateKey,
    protocol: PROTOCOL,
    now: 1_700_000_000,
  });
  return { pair, signed };
}

describe("verifyRequest", () => {
  it("accepts a request signed with a key it knows", async () => {
    const { pair, signed } = await signedRequest();
    const body = await signed.clone().arrayBuffer();
    const result = await verifyRequest(signed, body, {
      keys: new Map([["engine-k1", pair.publicKey]]),
      now: 1_700_000_010,
      expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: true, keyId: "engine-k1", nonce: expect.any(String) });
  });
});

describe("verifyRequest rejects", () => {
  const knownKeys = async (pair: CryptoKeyPair) => new Map([["engine-k1", pair.publicKey]]);

  it("a body that changed after signing", async () => {
    const { pair, signed } = await signedRequest({ method: "POST", body: '{"a":1}' });
    const result = await verifyRequest(signed, new TextEncoder().encode('{"a":2}').buffer as ArrayBuffer, {
      keys: await knownKeys(pair), now: 1_700_000_000, expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "digest_mismatch" });
  });

  it("a timestamp more than 300 seconds away in either direction", async () => {
    const { pair, signed } = await signedRequest();
    const body = await signed.clone().arrayBuffer();
    const late = await verifyRequest(signed, body, { keys: await knownKeys(pair), now: 1_700_000_301, expectedProtocol: PROTOCOL });
    const early = await verifyRequest(signed, body, { keys: await knownKeys(pair), now: 1_699_999_699, expectedProtocol: PROTOCOL });
    expect(late).toEqual({ ok: false, code: "unauthorized", reason: "timestamp_skew" });
    expect(early).toEqual({ ok: false, code: "unauthorized", reason: "timestamp_skew" });
  });

  it("a key id it does not know", async () => {
    const { signed } = await signedRequest();
    const other = await generateSigningKeyPair();
    const result = await verifyRequest(signed, await signed.clone().arrayBuffer(), {
      keys: new Map([["engine-k2", other.publicKey]]), now: 1_700_000_000, expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "unknown_key_id" });
  });

  it("a signature made with a different private key under the same key id", async () => {
    const { signed } = await signedRequest();
    const other = await generateSigningKeyPair();
    const result = await verifyRequest(signed, await signed.clone().arrayBuffer(), {
      keys: new Map([["engine-k1", other.publicKey]]), now: 1_700_000_000, expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "bad_signature" });
  });

  it("a protocol version other than the one it speaks", async () => {
    const { pair, signed } = await signedRequest();
    const result = await verifyRequest(signed, await signed.clone().arrayBuffer(), {
      keys: await knownKeys(pair), now: 1_700_000_000, expectedProtocol: "2.0",
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "protocol_mismatch" });
  });

  it("a request whose path was rewritten after signing", async () => {
    const { pair, signed } = await signedRequest();
    const moved = new Request("https://outpost.test.invalid/v1/store/wipe?x=1", { method: "GET", headers: signed.headers });
    const result = await verifyRequest(moved, await moved.clone().arrayBuffer(), {
      keys: await knownKeys(pair), now: 1_700_000_000, expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "bad_signature" });
  });

  it("a request with no signature headers at all", async () => {
    const pair = await generateSigningKeyPair();
    const bare = new Request("https://outpost.test.invalid/v1/meta");
    const result = await verifyRequest(bare, new ArrayBuffer(0), {
      keys: await knownKeys(pair), now: 1_700_000_000, expectedProtocol: PROTOCOL,
    });
    expect(result).toEqual({ ok: false, code: "unauthorized", reason: "missing_headers" });
  });
});
