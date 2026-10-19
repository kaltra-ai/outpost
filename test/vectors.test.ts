import { describe, it, expect } from "vitest";
import { signatureBase, verifyRequest } from "../src/signature";
import { engineKeys } from "../src/config";
import vector from "./fixtures/signature-vector-1.json";

describe("signature vector 1 (docs/signature-vectors.md)", () => {
  const request = () =>
    new Request(vector.request.url, { method: vector.request.method, headers: vector.headers, body: vector.request.body });

  it("reproduces the documented signature base byte for byte", () => {
    const req = request();
    const params = vector.headers["Signature-Input"].slice("sig1=".length);
    expect(signatureBase(req, req.headers, params)).toBe(vector.signature_base);
  });

  it("verifies the documented signature with the documented public key", async () => {
    const req = request();
    const keys = await engineKeys(JSON.stringify([{ key_id: vector.key_id, public_key: vector.public_key_raw_b64url }]));
    const result = await verifyRequest(req, await req.clone().arrayBuffer(), {
      keys, expectedProtocol: "1.1", now: Number(vector.headers["Kaltra-Timestamp"]),
    });
    expect(result).toEqual({ ok: true, keyId: vector.key_id, nonce: vector.headers["Kaltra-Nonce"] });
  });
});
