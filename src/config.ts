// Deployed configuration (docs/protocol-v1.md section 6). Read-only at runtime; never engine-writable.

export const OUTPOST_VERSION = "1.1.0"; // 1.1: doors are modules (src/doors/sdk.ts); the dev door is the one in this repo
// "none" (protocol 1.2 item, additive): no secret, nothing injected; allow-lists still apply. For public hosts such as a documentation bucket.
export const CREDENTIAL_TYPES = ["static_header", "oauth2_client_credentials", "hmac_key", "none"] as const;

export const LIMITS = {
  store_body_bytes: 1_048_576,
  llm_request_bytes: 33_554_432,
  llm_response_bytes: 8_388_608,
  source_request_bytes: 1_048_576,
  source_response_bytes: 26_214_400,
  fetch_response_bytes: 26_214_400,
  send_body_bytes: 1_048_576,
  inbound_body_bytes: 1_048_576,
  llm_timeout_ms: 120_000,
  source_timeout_ms: 30_000,
  d1_params_per_statement: 100,
  d1_statement_bytes: 102_400,
  d1_statements_per_request: 1_000,
} as const;

export interface EngineKey { key_id: string; public_key: string }

export interface InstanceConfig {
  id: string; module: string; kind: string; scope: unknown; audience: unknown; credential: string;
  oauth_scope?: string; timeout_s?: number;
}
export interface CredentialConfig {
  name: string; type: (typeof CREDENTIAL_TYPES)[number]; allowed_hosts: string[]; allowed_methods: string[];
  allowed_request_headers?: string[]; scopes?: string[]; config?: Record<string, unknown>;
}
export interface DoorConfig { kind: string; instance: string; credential: string; signing_credential?: string; settings?: Record<string, unknown> }
export interface KaltraConfig { instances: InstanceConfig[]; credentials: CredentialConfig[]; doors: DoorConfig[] }

export function parseKaltraConfig(raw: string): KaltraConfig {
  const parsed = JSON.parse(raw) as Partial<KaltraConfig>;
  return { instances: parsed.instances ?? [], credentials: parsed.credentials ?? [], doors: parsed.doors ?? [] };
}

export async function engineKeys(raw: string): Promise<Map<string, CryptoKey>> {
  const list = JSON.parse(raw) as EngineKey[];
  const keys = new Map<string, CryptoKey>();
  for (const k of list) {
    const bytes = base64urlToBytes(k.public_key);
    keys.set(k.key_id, await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]));
  }
  return keys;
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
