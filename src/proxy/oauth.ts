// OAuth2 client-credentials tokens for credentials of type oauth2_client_credentials (protocol section 6).
// Cached in KV keyed by (credential, scope): access token and expiry only, never the client secret.

import type { CredentialConfig } from "../config";

interface CachedToken { access_token: string; expires_at: number }

const SAFETY_MARGIN_S = 60;

export function tokenCacheKey(credential: string, scope: string): string {
  return `token:${credential}:${scope}`;
}

export async function bearerToken(env: Env, cred: CredentialConfig, secret: string, scope: string): Promise<string> {
  const key = tokenCacheKey(cred.name, scope);
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.TOKEN_CACHE.get<CachedToken>(key, "json");
  if (cached && cached.expires_at - SAFETY_MARGIN_S > now) return cached.access_token;

  const endpoint = String(cred.config?.token_endpoint ?? "");
  const clientId = String(cred.config?.client_id ?? "");
  if (!endpoint || !clientId) throw new Error("oauth2 credential is missing token_endpoint or client_id");
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope });
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, redirect: "manual" });
  if (!res.ok) throw new UpstreamAuthError(res.status);
  const token = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!token.access_token) throw new UpstreamAuthError(res.status);
  const expires_at = now + (token.expires_in ?? 3600);
  await env.TOKEN_CACHE.put(key, JSON.stringify({ access_token: token.access_token, expires_at } satisfies CachedToken), { expirationTtl: Math.max(60, expires_at - now) });
  return token.access_token;
}

export async function invalidateToken(env: Env, credential: string, scope: string): Promise<void> {
  await env.TOKEN_CACHE.delete(tokenCacheKey(credential, scope));
}

export class UpstreamAuthError extends Error {
  constructor(public readonly status: number) {
    super(`token endpoint returned ${status}`);
  }
}
