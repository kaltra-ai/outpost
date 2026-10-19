// Dev door: the operator-internal QA door (protocol 1.2). Exists only when a tenant's door config lists kind "dev".
// Same envelope, same queue, same engine path as a platform door; replies are stored and polled instead of posted.

import { errorResponse, ensureOutpostSchema, credentialSecret, findDoor, verifyV0Signature, INBOUND_TTL_SECONDS, THREAD_TTL_SECONDS, type DoorConfig, type DoorModule } from "./sdk";

interface DevMessage { subject_id?: unknown; display_name?: unknown; text?: unknown; thread_id?: unknown; groups?: unknown; scope?: unknown }

async function authenticate(req: Request, env: Env, instance: string): Promise<{ door: DoorConfig; body: ArrayBuffer } | Response> {
  const door = findDoor(env, "dev", instance);
  if (!door) return errorResponse("unknown_route");
  const secret = credentialSecret(env, String((door as DoorConfig & { signing_credential?: string }).signing_credential ?? door.credential));
  if (!secret) return errorResponse("unavailable");
  const body = await req.arrayBuffer();
  // The v0 HMAC scheme, with the dev door's header names.
  const ok = await verifyV0Signature(secret, req.headers.get("x-kaltra-dev-timestamp"), req.headers.get("x-kaltra-dev-signature"), body);
  if (!ok) return errorResponse("unauthorized");
  return { door, body };
}

export async function devInbound(req: Request, env: Env, instance: string): Promise<Response> {
  const auth = await authenticate(req, env, instance);
  if (auth instanceof Response) return auth;
  let msg: DevMessage;
  try { msg = JSON.parse(new TextDecoder().decode(auth.body)) as DevMessage; } catch { return errorResponse("invalid_request"); }
  if (typeof msg.subject_id !== "string" || typeof msg.text !== "string" || typeof msg.thread_id !== "string") return errorResponse("invalid_request");

  const db = env.STORE;
  await ensureOutpostSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const threadId = await devEnsureThread(env, instance, msg.thread_id, now);
  const eventId = `dev-${crypto.randomUUID()}`;
  const groups = Array.isArray(msg.groups) ? (msg.groups as unknown[]).filter((g): g is string => typeof g === "string").map((g) => ({ provider: "dev", id: g })) : null;
  const scope = msg.scope === "channel" || msg.scope === "group" ? msg.scope : "personal";
  const envelope = {
    event_id: eventId, door: { kind: "dev", instance, adapter_version: "1.0" }, thread_id: threadId, scope,
    member: { subject_id: msg.subject_id, display_name: typeof msg.display_name === "string" ? msg.display_name : null, groups, groups_as_of: groups ? new Date(now * 1000).toISOString() : null },
    text: msg.text, addressed_to_bot: true, mentions: [], attachments: [], interaction: null, received_at: new Date(now * 1000).toISOString(),
  };
  await db.prepare("INSERT INTO o_inbound (door_kind, instance, event_id, envelope, received_at, expires_at) VALUES ('dev', ?1, ?2, ?3, ?4, ?5)").bind(instance, eventId, JSON.stringify(envelope), now, now + INBOUND_TTL_SECONDS).run();
  await env.INBOUND.send({ event_id: eventId, door_kind: "dev", instance });
  return Response.json({ event_id: eventId, thread_id: threadId }, { status: 202 });
}

/** The o_threads row for a dev thread: reuse the one it has, else mint a thread_id. Keyed `dev:<dev_thread>`. */
export async function devEnsureThread(env: Env, instance: string, devThread: string, now: number): Promise<string> {
  const db = env.STORE;
  const platformKey = `dev:${devThread}`;
  const existing = await db.prepare("SELECT thread_id FROM o_threads WHERE door_kind = 'dev' AND instance = ?1 AND platform_key = ?2").bind(instance, platformKey).first<{ thread_id: string }>();
  if (existing) return existing.thread_id;
  const threadId = crypto.randomUUID();
  await db.prepare("INSERT INTO o_threads (thread_id, door_kind, instance, platform_key, platform, expires_at) VALUES (?1, 'dev', ?2, ?3, ?4, ?5)").bind(threadId, instance, platformKey, JSON.stringify({ dev_thread: devThread }), now + THREAD_TTL_SECONDS).run();
  return threadId;
}

/** The notify half for the dev door: the notification is a stored reply in the thread `notify:<subject_id>`, which a later dev message continues. */
export async function devNotify(env: Env, instance: string, subjectId: string, text: string): Promise<{ ok: true; platform_message_id: string; thread_id: string }> {
  await ensureOutpostSchema(env.STORE);
  const devThread = `notify:${subjectId}`;
  const threadId = await devEnsureThread(env, instance, devThread, Math.floor(Date.now() / 1000));
  const stored = await devStoreReply(env, instance, { dev_thread: devThread }, text);
  return { ok: true, platform_message_id: stored.platform_message_id, thread_id: threadId };
}

/** The send half for dev threads: store the reply for polling. */
export async function devStoreReply(env: Env, instance: string, platform: Record<string, unknown>, text: string): Promise<{ ok: true; platform_message_id: string }> {
  const db = env.STORE;
  const devThread = String(platform.dev_thread ?? "");
  const row = await db.prepare("INSERT INTO o_dev_replies (instance, dev_thread, seq, text, created_at) SELECT ?1, ?2, COALESCE(MAX(seq), 0) + 1, ?3, ?4 FROM o_dev_replies WHERE instance = ?1 AND dev_thread = ?2 RETURNING seq").bind(instance, devThread, text, Math.floor(Date.now() / 1000)).first<{ seq: number }>();
  return { ok: true, platform_message_id: String(row?.seq ?? 0) };
}

export async function devReplies(req: Request, env: Env, instance: string): Promise<Response> {
  const auth = await authenticate(req, env, instance);
  if (auth instanceof Response) return auth;
  let q: { thread_id?: unknown; after?: unknown };
  try { q = JSON.parse(new TextDecoder().decode(auth.body)) as typeof q; } catch { return errorResponse("invalid_request"); }
  if (typeof q.thread_id !== "string") return errorResponse("invalid_request");
  await ensureOutpostSchema(env.STORE);
  const after = Number.isInteger(q.after) ? Number(q.after) : 0;
  const rows = await env.STORE.prepare("SELECT seq, text, created_at FROM o_dev_replies WHERE instance = ?1 AND dev_thread = ?2 AND seq > ?3 ORDER BY seq").bind(instance, q.thread_id, after).all<{ seq: number; text: string; created_at: number }>();
  return Response.json({ replies: rows.results });
}

/** The dev door as a module: the reference implementation of the door SDK. */
export const devDoor: DoorModule = {
  kind: "dev",
  adapter_version: "1.0",
  inbound: (req, env, instance) => devInbound(req, env, instance),
  send: (env, _door, instance, platform, reply) => devStoreReply(env, instance, platform, reply.text),
  notify: (env, _door, instance, subjectId, reply) => devNotify(env, instance, subjectId, reply.text),
  routes: { replies: (req, env, instance) => devReplies(req, env, instance) },
};
