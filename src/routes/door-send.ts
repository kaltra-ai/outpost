import { errorResponse, type ErrorCode } from "../errors";
import { OUTPOST_VERSION } from "../config";
import { ensureOutpostSchema } from "../store/schema";
import { auditStatement, sha256Hex } from "../store/audit";
import { findDoor } from "../doors/sdk";
import { doorModule } from "../doors/registry";
import type { RouteContext } from "../context";

type Json = Record<string, unknown>;

export async function loadThread(env: Env, threadId: string): Promise<{ door_kind: string; instance: string; platform: Json } | null> {
  await ensureOutpostSchema(env.STORE);
  const row = await env.STORE.prepare("SELECT door_kind, instance, platform FROM o_threads WHERE thread_id = ?1 AND expires_at > ?2").bind(threadId, Math.floor(Date.now() / 1000)).first<{ door_kind: string; instance: string; platform: string }>();
  return row ? { door_kind: row.door_kind, instance: row.instance, platform: JSON.parse(row.platform) as Json } : null;
}

export async function doorSend(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const db = env.STORE;
  await ensureOutpostSchema(db);
  let p: Json;
  try { p = JSON.parse(new TextDecoder().decode(ctx.body)) as Json; } catch { return errorResponse("invalid_request"); }
  const request_id = typeof p.request_id === "string" ? p.request_id : undefined;
  const key = p.idempotency_key;
  const threadId = p.thread_id;
  const text = p.text;
  const format = p.format;
  const actions = p.actions;
  const now = Math.floor(Date.now() / 1000);
  const audit = (status: number, extra: { error_code?: ErrorCode | null; duplicate?: boolean; bytes_out?: number } = {}) =>
    db.batch([auditStatement(db, { request_id: request_id ?? crypto.randomUUID(), route: ctx.route, actor: "engine", key_id: ctx.auth.keyId, protocol_version: ctx.auth.protocol, instance_id: `${ctx.params.kind}/${ctx.params.instance}`, bytes_in: ctx.body.byteLength, duration_ms: Date.now() - ctx.startedAt, status, ...extra })]);
  const fail = async (code: ErrorCode, extra: { retry_after_ms?: number } = {}) => { const r = errorResponse(code, { request_id, ...extra }); await audit(r.status, { error_code: code }); return r; };

  if (request_id === undefined || typeof key !== "string" || typeof threadId !== "string" || typeof text !== "string" || (format !== "plain" && format !== "markdown") || (actions !== undefined && !(Array.isArray(actions) && actions.length === 0))) {
    return fail("invalid_request");
  }
  const thread = await loadThread(env, threadId);
  if (!thread || thread.door_kind !== ctx.params.kind || thread.instance !== ctx.params.instance) return fail("instance_not_found");
  const door = findDoor(env, ctx.params.kind, ctx.params.instance);
  if (!door) return fail("instance_not_found");

  // Nonce, then idempotency: a redelivery is a replay; a retry with a fresh nonce gets the stored response.
  try {
    await db.prepare("INSERT INTO o_nonces (key_id, nonce, seen_at) VALUES (?1, ?2, ?3)").bind(ctx.auth.keyId, ctx.auth.nonce, now).run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: o_nonces/.test(e.message)) return fail("unauthorized");
    throw e;
  }
  const requestHash = await sha256Hex(ctx.body);
  const existing = await db.prepare("SELECT request_hash, status, response_body FROM o_idempotency WHERE route = ?1 AND key = ?2").bind(ctx.route, key).first<{ request_hash: string; status: number; response_body: string | null }>();
  if (existing) {
    if (existing.request_hash !== requestHash) return fail("idempotency_conflict");
    const status = existing.status || 200; // 0: sent (or mid-send when the isolate died), response never recorded
    const body = status === existing.status && existing.response_body ? (JSON.parse(existing.response_body) as Json) : { request_id, outpost_version: OUTPOST_VERSION, platform_message_id: null, response_lost: true };
    await audit(status, { duplicate: true });
    return Response.json({ ...body, duplicate: true }, { status });
  }
  // Reserve the key before the external call so a crash mid-send is reported as response_lost, never re-sent.
  await db.prepare("INSERT INTO o_idempotency (route, key, request_hash, status, response_body, created_at) VALUES (?1, ?2, ?3, 0, NULL, ?4)").bind(ctx.route, key, requestHash, now).run();

  const module = doorModule(ctx.params.kind);
  if (!module) return fail("unknown_route");
  const outcome = await module.send(env, door, ctx.params.instance, thread.platform, { text, format });
  if (!outcome.ok) {
    // Delivery failures are retryable by the engine with a fresh key; release the reservation.
    await db.prepare("DELETE FROM o_idempotency WHERE route = ?1 AND key = ?2").bind(ctx.route, key).run();
    return fail(outcome.code, outcome.code === "upstream_rate_limited" ? { retry_after_ms: outcome.retry_after_ms } : {});
  }
  if (module.afterSend) await module.afterSend(env, door, threadId, thread.platform);
  const body: Json = { request_id, outpost_version: OUTPOST_VERSION, platform_message_id: outcome.platform_message_id };
  await db.prepare("UPDATE o_idempotency SET status = 200, response_body = ?1 WHERE route = ?2 AND key = ?3").bind(JSON.stringify(body), ctx.route, key).run();
  await audit(200, { bytes_out: text.length });
  return Response.json(body);
}
