// POST /v1/door/<kind>/<instance>/notify (protocol 1.2): the engine starts a conversation with one member.
// Same nonce, idempotency, and audit discipline as /send; the difference is the target (a member, not a known thread)
// and the extra step of registering the opened conversation so the member's reply comes back as a normal inbound.

import { errorResponse, type ErrorCode } from "../errors";
import { OUTPOST_VERSION } from "../config";
import { ensureOutpostSchema } from "../store/schema";
import { auditStatement, sha256Hex } from "../store/audit";
import { findDoor } from "../doors/sdk";
import { doorModule } from "../doors/registry";
import type { RouteContext } from "../context";

type Json = Record<string, unknown>;

export async function doorNotify(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const db = env.STORE;
  await ensureOutpostSchema(db);
  let p: Json;
  try { p = JSON.parse(new TextDecoder().decode(ctx.body)) as Json; } catch { return errorResponse("invalid_request"); }
  const request_id = typeof p.request_id === "string" ? p.request_id : undefined;
  const engineVersion = typeof p.engine_version === "string" ? p.engine_version : null;
  const key = p.idempotency_key;
  const subjectId = p.subject_id;
  const text = p.text;
  const format = p.format;
  const now = Math.floor(Date.now() / 1000);
  const audit = (status: number, extra: { error_code?: ErrorCode | null; duplicate?: boolean; bytes_out?: number } = {}) =>
    db.batch([auditStatement(db, { request_id: request_id ?? crypto.randomUUID(), route: ctx.route, actor: "engine", key_id: ctx.auth.keyId, protocol_version: ctx.auth.protocol, engine_version: engineVersion, instance_id: `${ctx.params.kind}/${ctx.params.instance}`, member_subject_id: typeof subjectId === "string" ? subjectId : null, bytes_in: ctx.body.byteLength, duration_ms: Date.now() - ctx.startedAt, status, ...extra })]);
  const fail = async (code: ErrorCode, extra: { retry_after_ms?: number } = {}) => { const r = errorResponse(code, { request_id, ...extra }); await audit(r.status, { error_code: code }); return r; };

  if (request_id === undefined || typeof key !== "string" || typeof subjectId !== "string" || subjectId.length === 0 || typeof text !== "string" || (format !== "plain" && format !== "markdown")) {
    return fail("invalid_request");
  }
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
    const body = status === existing.status && existing.response_body ? (JSON.parse(existing.response_body) as Json) : { request_id, outpost_version: OUTPOST_VERSION, platform_message_id: null, thread_id: null, response_lost: true };
    await audit(status, { duplicate: true });
    return Response.json({ ...body, duplicate: true }, { status });
  }
  // Reserve the key before the external call so a crash mid-send is reported as response_lost, never re-sent.
  await db.prepare("INSERT INTO o_idempotency (route, key, request_hash, status, response_body, created_at) VALUES (?1, ?2, ?3, 0, NULL, ?4)").bind(ctx.route, key, requestHash, now).run();

  const module = doorModule(ctx.params.kind);
  if (!module) return fail("unknown_route");
  const outcome = await module.notify(env, door, ctx.params.instance, subjectId, { text, format });
  if (!outcome.ok) {
    // Delivery failures are retryable by the engine with a fresh key; release the reservation.
    await db.prepare("DELETE FROM o_idempotency WHERE route = ?1 AND key = ?2").bind(ctx.route, key).run();
    return fail(outcome.code, outcome.code === "upstream_rate_limited" ? { retry_after_ms: outcome.retry_after_ms } : {});
  }
  const body: Json = { request_id, outpost_version: OUTPOST_VERSION, platform_message_id: outcome.platform_message_id, thread_id: outcome.thread_id };
  await db.prepare("UPDATE o_idempotency SET status = 200, response_body = ?1 WHERE route = ?2 AND key = ?3").bind(JSON.stringify(body), ctx.route, key).run();
  await audit(200, { bytes_out: text.length });
  return Response.json(body);
}
