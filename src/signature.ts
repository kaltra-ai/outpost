// RFC 9421 HTTP Message Signatures, Ed25519, as specified in docs/protocol-v1.md section 2.
// Covered components, in this order:
//   @method @authority @path @query content-digest kaltra-protocol kaltra-key-id kaltra-timestamp kaltra-nonce

export const COVERED_COMPONENTS = [
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "kaltra-protocol",
  "kaltra-key-id",
  "kaltra-timestamp",
  "kaltra-nonce",
] as const;

export const SIGNATURE_LABEL = "sig1";
export const DEFAULT_MAX_SKEW_SECONDS = 300;

export interface SignOptions {
  keyId: string;
  privateKey: CryptoKey;
  protocol: string;
  /** Unix seconds. Defaults to the current time. */
  now?: number;
  /** base64url nonce. Defaults to 128 random bits. */
  nonce?: string;
}

export interface VerifyOptions {
  keys: Map<string, CryptoKey>;
  expectedProtocol: string;
  /** Unix seconds. Defaults to the current time. */
  now?: number;
  maxSkewSeconds?: number;
}

export type VerifyResult =
  | { ok: true; keyId: string; nonce: string }
  | { ok: false; code: "unauthorized"; reason: string };

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function signRequest(req: Request, opts: SignOptions): Promise<Request> {
  const body = await req.clone().arrayBuffer();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomNonce();
  const digest = await contentDigest(body);

  const headers = new Headers(req.headers);
  headers.set("Content-Digest", digest);
  headers.set("Kaltra-Protocol", opts.protocol);
  headers.set("Kaltra-Key-Id", opts.keyId);
  headers.set("Kaltra-Timestamp", String(now));
  headers.set("Kaltra-Nonce", nonce);

  const params = signatureParams(now, opts.keyId);
  const base = signatureBase(req, headers, params);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, opts.privateKey, new TextEncoder().encode(base));
  headers.set("Signature-Input", `${SIGNATURE_LABEL}=${params}`);
  headers.set("Signature", `${SIGNATURE_LABEL}=:${base64(new Uint8Array(sig))}:`);

  return new Request(req.url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

export async function verifyRequest(req: Request, body: ArrayBuffer, opts: VerifyOptions): Promise<VerifyResult> {
  const fail = (reason: string): VerifyResult => ({ ok: false, code: "unauthorized", reason });
  const h = req.headers;
  const protocol = h.get("Kaltra-Protocol");
  const keyId = h.get("Kaltra-Key-Id");
  const timestamp = h.get("Kaltra-Timestamp");
  const nonce = h.get("Kaltra-Nonce");
  const digest = h.get("Content-Digest");
  const sigInput = h.get("Signature-Input");
  const sig = h.get("Signature");
  if (!protocol || !keyId || !timestamp || !nonce || !digest || !sigInput || !sig) return fail("missing_headers");

  if (protocol !== opts.expectedProtocol) return fail("protocol_mismatch");

  const key = opts.keys.get(keyId);
  if (!key) return fail("unknown_key_id");

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  const maxSkew = opts.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (!Number.isInteger(ts) || Math.abs(now - ts) > maxSkew) return fail("timestamp_skew");

  if (digest !== (await contentDigest(body))) return fail("digest_mismatch");

  const expectedParams = signatureParams(ts, keyId);
  if (sigInput !== `${SIGNATURE_LABEL}=${expectedParams}`) return fail("signature_input_mismatch");

  const sigBytes = parseSignatureHeader(sig);
  if (!sigBytes) return fail("malformed_signature");

  const base = signatureBase(req, h, expectedParams);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, new TextEncoder().encode(base));
  if (!valid) return fail("bad_signature");

  return { ok: true, keyId, nonce };
}

/** The exact signature base string. Exported so docs/signature-vectors.md can be generated from it. */
export function signatureBase(req: Request, headers: Headers, params: string): string {
  const url = new URL(req.url);
  const lines: string[] = [];
  for (const c of COVERED_COMPONENTS) {
    let value: string;
    switch (c) {
      case "@method":
        value = req.method.toUpperCase();
        break;
      case "@authority":
        value = url.host.toLowerCase();
        break;
      case "@path":
        value = url.pathname;
        break;
      case "@query":
        value = url.search === "" ? "?" : url.search;
        break;
      default:
        value = headers.get(c) ?? "";
    }
    lines.push(`"${c}": ${value}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

function signatureParams(created: number, keyId: string): string {
  const list = COVERED_COMPONENTS.map((c) => `"${c}"`).join(" ");
  return `(${list});created=${created};keyid="${keyId}";alg="ed25519"`;
}

async function contentDigest(body: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", body);
  return `sha-256=:${base64(new Uint8Array(hash))}:`;
}

function parseSignatureHeader(value: string): Uint8Array | null {
  const m = value.match(new RegExp(`^${SIGNATURE_LABEL}=:([A-Za-z0-9+/=]+):$`));
  if (!m) return null;
  try {
    return Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
