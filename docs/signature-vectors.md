# Signature test vector (protocol v1.1)

Both the engine and the outpost must reproduce this vector exactly in CI. Scheme: RFC 9421 HTTP Message Signatures, algorithm `ed25519`, covered components in this order: `@method`, `@authority`, `@path`, `@query`, `content-digest`, `kaltra-protocol`, `kaltra-key-id`, `kaltra-timestamp`, `kaltra-nonce`. `Content-Digest` is `sha-256=:<base64>:` over the raw body bytes. `@query` is the query string including its leading `?`, or a single `?` when the URL has no query. `@authority` is the lowercased host. Lines of the signature base are joined with a single line feed, no trailing newline. The signature is over the UTF-8 bytes of the base.

The key below is a TEST-ONLY keypair (`test/fixtures/engine-test-key.json`). Machine-readable copy: `test/fixtures/signature-vector-1.json`, pinned by `test/vectors.test.ts`. Regenerate with `node scripts/gen-signature-vector.mjs`.

## Input

- Key id: `engine-test-k1`
- Public key (raw Ed25519, base64url): `h12R0sY6ov51NYsfp8Pt8k9T42yGozQ4a2xCkvHvg9Y`
- Request: `POST https://outpost.example.test/v1/store/query?mode=read`
- Body (UTF-8): `{"statements":[{"sql":"SELECT 1","params":[]}],"mode":"read"}`
- Kaltra-Timestamp: `1700000000`
- Kaltra-Nonce: `AAECAwQFBgcICQoLDA0ODw`

## Signature base

```
"@method": POST
"@authority": outpost.example.test
"@path": /v1/store/query
"@query": ?mode=read
"content-digest": sha-256=:7yfA64ME3gdkzHuvmPXOBRS5fGa+sG/GQhBYyHM9BVY=:
"kaltra-protocol": 1.1
"kaltra-key-id": engine-test-k1
"kaltra-timestamp": 1700000000
"kaltra-nonce": AAECAwQFBgcICQoLDA0ODw
"@signature-params": ("@method" "@authority" "@path" "@query" "content-digest" "kaltra-protocol" "kaltra-key-id" "kaltra-timestamp" "kaltra-nonce");created=1700000000;keyid="engine-test-k1";alg="ed25519"
```

## Resulting headers

| Header | Value |
|---|---|
| `Content-Digest` | `sha-256=:7yfA64ME3gdkzHuvmPXOBRS5fGa+sG/GQhBYyHM9BVY=:` |
| `Kaltra-Protocol` | `1.1` |
| `Kaltra-Key-Id` | `engine-test-k1` |
| `Kaltra-Timestamp` | `1700000000` |
| `Kaltra-Nonce` | `AAECAwQFBgcICQoLDA0ODw` |
| `Signature-Input` | `sig1=("@method" "@authority" "@path" "@query" "content-digest" "kaltra-protocol" "kaltra-key-id" "kaltra-timestamp" "kaltra-nonce");created=1700000000;keyid="engine-test-k1";alg="ed25519"` |
| `Signature` | `sig1=:fKd3YHOthMxfgoeSre3Xc8nKUOFqkDBQUqeuye0VyLh8H4dfF4lf2oQDn6bCbcNhiCwuITY04AzeU8L0/QHaDA==:` |
