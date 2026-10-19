// Regenerates test/fixtures/signature-vector-1.json and docs/signature-vectors.md from the implementation.
// Run: node scripts/gen-signature-vector.mjs   (Node 22.6+ with type stripping; Node 26 has it by default)
import { readFileSync, writeFileSync } from "node:fs";
import { signRequest, signatureBase } from "../src/signature.ts";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/engine-test-key.json", import.meta.url), "utf8"));
const b64uToBytes = (s) => Uint8Array.from(Buffer.from(s, "base64url"));
const priv = await crypto.subtle.importKey("pkcs8", b64uToBytes(fixture.private_key_pkcs8_b64url), { name: "Ed25519" }, false, ["sign"]);

const body = '{"statements":[{"sql":"SELECT 1","params":[]}],"mode":"read"}';
const url = "https://outpost.example.test/v1/store/query?mode=read";
const req = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body });
const signed = await signRequest(req, { keyId: fixture.key_id, privateKey: priv, protocol: "1.1", now: 1_700_000_000, nonce: "AAECAwQFBgcICQoLDA0ODw" });
const params = signed.headers.get("Signature-Input").slice("sig1=".length);
const headerNames = ["Content-Digest", "Kaltra-Protocol", "Kaltra-Key-Id", "Kaltra-Timestamp", "Kaltra-Nonce", "Signature-Input", "Signature"];
const vector = {
  key_id: fixture.key_id,
  public_key_raw_b64url: fixture.public_key_raw_b64url,
  request: { method: "POST", url, body },
  headers: Object.fromEntries(headerNames.map((h) => [h, signed.headers.get(h)])),
  signature_base: signatureBase(req, signed.headers, params),
};
writeFileSync(new URL("../test/fixtures/signature-vector-1.json", import.meta.url), JSON.stringify(vector, null, 2) + "\n");

const doc = `# Signature test vector (protocol v1.1)

Both the engine and the outpost must reproduce this vector exactly in CI. Scheme: RFC 9421 HTTP Message Signatures, algorithm \`ed25519\`, covered components in this order: \`@method\`, \`@authority\`, \`@path\`, \`@query\`, \`content-digest\`, \`kaltra-protocol\`, \`kaltra-key-id\`, \`kaltra-timestamp\`, \`kaltra-nonce\`. \`Content-Digest\` is \`sha-256=:<base64>:\` over the raw body bytes. \`@query\` is the query string including its leading \`?\`, or a single \`?\` when the URL has no query. \`@authority\` is the lowercased host. Lines of the signature base are joined with a single line feed, no trailing newline. The signature is over the UTF-8 bytes of the base.

The key below is a TEST-ONLY keypair (\`test/fixtures/engine-test-key.json\`). Machine-readable copy: \`test/fixtures/signature-vector-1.json\`, pinned by \`test/vectors.test.ts\`. Regenerate with \`node scripts/gen-signature-vector.mjs\`.

## Input

- Key id: \`${vector.key_id}\`
- Public key (raw Ed25519, base64url): \`${vector.public_key_raw_b64url}\`
- Request: \`${vector.request.method} ${vector.request.url}\`
- Body (UTF-8): \`${vector.request.body}\`
- Kaltra-Timestamp: \`${vector.headers["Kaltra-Timestamp"]}\`
- Kaltra-Nonce: \`${vector.headers["Kaltra-Nonce"]}\`

## Signature base

\`\`\`
${vector.signature_base}
\`\`\`

## Resulting headers

| Header | Value |
|---|---|
${headerNames.map((h) => `| \`${h}\` | \`${vector.headers[h]}\` |`).join("\n")}
`;
writeFileSync(new URL("../docs/signature-vectors.md", import.meta.url), doc);
console.log("vector written");
