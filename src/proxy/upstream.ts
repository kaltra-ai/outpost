// Outbound proxy shared by /v1/llm and /v1/source (protocol sections 4.2, 4.3, 6).
// The outpost builds the URL itself, injects the credential, and never forwards a header it was not told to allow.
// Redirects are never followed (Workers has no redirect: "error"; "manual" returns the 3xx untouched, so a credential only ever reaches the allow-listed host).

import { errorResponse, type ErrorCode } from "../errors";
import { parseKaltraConfig, type CredentialConfig } from "../config";
import { auditStatement } from "../store/audit";
import { ensureOutpostSchema } from "../store/schema";
import { bearerToken, invalidateToken, UpstreamAuthError } from "./oauth";
import type { RouteContext } from "../context";

const DEFAULT_ALLOWED_HEADERS = ["content-type", "accept"];
// Never forwarded from the engine, whatever the credential allows (protocol section 6).
const ALWAYS_DROPPED_HEADERS = new Set(["authorization", "cookie", "host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authorization", "te", "trailer", "upgrade"]);
const UPSTREAM_HEADER_PREFIX = "kaltra-upstream-header-";

export interface ProxyPlan {
  credential: CredentialConfig;
  scope?: string;
  instanceId?: string;
  timeoutMs: number;
  responseCap: number;
  parseUsage: boolean;
}

interface Usage { input_tokens: number | null; output_tokens: number | null; model: string | null }

export function credentialSecret(env: Env, name: string): string | undefined {
  const key = "KALTRA_CRED_" + name.toUpperCase().replace(/-/g, "_");
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function findCredential(env: Env, name: string): CredentialConfig | undefined {
  return parseKaltraConfig(env.KALTRA_CONFIG).credentials.find((c) => c.name === name);
}

function readUpstreamHeaders(req: Request): { method: string; path: string; query: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    if (name.startsWith(UPSTREAM_HEADER_PREFIX)) headers[name.slice(UPSTREAM_HEADER_PREFIX.length)] = value;
  });
  return {
    method: (req.headers.get("Kaltra-Upstream-Method") ?? "").toUpperCase(),
    path: req.headers.get("Kaltra-Upstream-Path") ?? "",
    query: req.headers.get("Kaltra-Upstream-Query") ?? "",
    headers,
  };
}

function buildUrl(host: string, path: string, query: string): URL | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || path.includes("@") || /[\s#?]/.test(path)) return null;
  const url = new URL(`https://${host}${path}`);
  if (url.host !== host || url.pathname !== path) return null;
  if (query) url.search = query.startsWith("?") ? query : `?${query}`;
  return url;
}

function parseUsage(body: ArrayBuffer): Usage {
  try {
    const j = JSON.parse(new TextDecoder().decode(body)) as { usage?: Record<string, number>; model?: string };
    const u = j.usage ?? {};
    return {
      input_tokens: u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? null,
      output_tokens: u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? null,
      model: typeof j.model === "string" ? j.model : null,
    };
  } catch {
    return { input_tokens: null, output_tokens: null, model: null };
  }
}

function retryAfterMs(res: Response): number {
  const raw = res.headers.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : 1000;
}

export async function proxy(ctx: RouteContext, plan: ProxyPlan): Promise<Response> {
  const { env } = ctx;
  const cred = plan.credential;
  const up = readUpstreamHeaders(ctx.req);
  const requestId = ctx.req.headers.get("Kaltra-Request-Id") ?? crypto.randomUUID();
  const audit = async (status: number, extra: { host?: string; error_code?: ErrorCode | null; usage?: Usage; bytes_out?: number }) => {
    await ensureOutpostSchema(env.STORE);
    await env.STORE.batch([
      auditStatement(env.STORE, {
        request_id: requestId, route: ctx.route, actor: "engine", key_id: ctx.auth.keyId, protocol_version: ctx.auth.protocol,
        credential_name: cred.name, instance_id: plan.instanceId ?? null, host: extra.host ?? null,
        bytes_in: ctx.body.byteLength, bytes_out: extra.bytes_out ?? null,
        tokens_in: extra.usage?.input_tokens ?? null, tokens_out: extra.usage?.output_tokens ?? null, model: extra.usage?.model ?? null,
        duration_ms: Date.now() - ctx.startedAt, status, error_code: extra.error_code ?? null,
      }),
    ]);
  };
  const fail = async (code: ErrorCode, extra: { host?: string; retry_after_ms?: number } = {}) => {
    const res = errorResponse(code, { request_id: requestId, retry_after_ms: extra.retry_after_ms });
    await audit(res.status, { host: extra.host, error_code: code });
    return res;
  };

  const host = cred.allowed_hosts.find((h) => h === h.toLowerCase() && h.length > 0);
  if (!host) return fail("host_not_allowed");
  if (!up.method || !cred.allowed_methods.map((m) => m.toUpperCase()).includes(up.method)) return fail("method_not_allowed", { host });
  const allowedHeaders = new Set((cred.allowed_request_headers ?? DEFAULT_ALLOWED_HEADERS).map((h) => h.toLowerCase()));
  for (const name of Object.keys(up.headers)) {
    if (ALWAYS_DROPPED_HEADERS.has(name) || !allowedHeaders.has(name)) return fail("header_not_allowed", { host });
  }
  const url = buildUrl(host, up.path, up.query);
  if (!url) return fail("invalid_request", { host });

  const secret = cred.type === "none" ? "" : credentialSecret(env, cred.name);
  if (secret === undefined) return fail("credential_not_found", { host });

  const headers = new Headers(up.headers);
  const attempt = async (retryOn401: boolean): Promise<Response> => {
    if (cred.type === "static_header") {
      headers.set(String(cred.config?.header_name ?? "authorization"), secret);
    } else if (cred.type === "oauth2_client_credentials") {
      const scope = plan.scope ?? cred.scopes?.[0];
      if (!scope) throw new Error("oauth2 credential has no scope");
      headers.set("authorization", `Bearer ${await bearerToken(env, cred, secret, scope)}`);
    } else if (cred.type === "none") {
      // nothing injected
    } else {
      throw new Error(`credential type ${cred.type} cannot be injected into an outbound call`);
    }
    const res = await fetch(url, {
      method: up.method,
      headers,
      body: up.method === "GET" || up.method === "HEAD" ? undefined : ctx.body,
      redirect: "manual",
      signal: AbortSignal.timeout(plan.timeoutMs),
    });
    if (res.status === 401 && retryOn401 && cred.type === "oauth2_client_credentials") {
      await invalidateToken(env, cred.name, plan.scope ?? cred.scopes?.[0] ?? "");
      return attempt(false);
    }
    return res;
  };

  let res: Response;
  try {
    res = await attempt(true);
  } catch (e) {
    console.log(JSON.stringify({ event: "upstream_failed", route: ctx.route, credential: cred.name, host, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    if (e instanceof UpstreamAuthError) return fail("upstream_error", { host });
    if (e instanceof Error && e.name === "TimeoutError") return fail("upstream_timeout", { host });
    return fail("upstream_error", { host });
  }

  if (res.status === 429) return fail("upstream_rate_limited", { host, retry_after_ms: retryAfterMs(res) });

  const body = await res.arrayBuffer();
  if (body.byteLength > plan.responseCap) return fail("payload_too_large", { host });
  const usage = plan.parseUsage ? parseUsage(body) : undefined;

  const out = new Headers();
  out.set("Kaltra-Upstream-Status", String(res.status));
  out.set("Kaltra-Request-Id", requestId);
  const ct = res.headers.get("content-type");
  if (ct) out.set("content-type", ct);
  if (usage) out.set("Kaltra-Usage", JSON.stringify(usage));
  await audit(200, { host, usage, bytes_out: body.byteLength });
  return new Response(body, { status: 200, headers: out });
}
