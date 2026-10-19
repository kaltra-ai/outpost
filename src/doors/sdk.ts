// The door SDK (protocol section 4): what a door module needs from the outpost, and the shape the outpost expects back.
// A door turns a platform's events into envelopes on the inbound queue, and posts the engine's replies and notifications.
// The dev door in this repo is the reference implementation; platform doors (Slack, Teams) are separate packages.

import { parseKaltraConfig, type DoorConfig } from "../config";

export type { DoorConfig };
export { credentialSecret } from "../proxy/upstream";
export { ensureOutpostSchema } from "../store/schema";
export { errorResponse } from "../errors";

export const INBOUND_TTL_SECONDS = 7 * 86_400;
export const THREAD_TTL_SECONDS = 24 * 3600;
export const ATTACHMENT_TTL_SECONDS = 24 * 3600;
const V0_SKEW_SECONDS = 300;

export interface DoorReply { text: string; format: "plain" | "markdown" }
export type SendOutcome =
  | { ok: true; platform_message_id: string }
  | { ok: false; code: "upstream_rate_limited"; retry_after_ms: number }
  | { ok: false; code: "recipient_blocked" | "upstream_error" | "upstream_timeout" };
export type NotifyOutcome = { ok: true; platform_message_id: string; thread_id: string } | Exclude<SendOutcome, { ok: true }>;

export type DoorRouteHandler = (req: Request, env: Env, instance: string, ctx?: ExecutionContext) => Promise<Response>;

/** One door kind. Registered at startup (src/doors/registry.ts); the routes and the consumer dispatch on envelope.door.kind. */
export interface DoorModule {
  kind: string;
  adapter_version: string;
  /** POST /door/<kind>/<instance>: verify the platform's signature, build the envelope, enqueue, acknowledge. */
  inbound: DoorRouteHandler;
  /** POST /v1/door/<kind>/<instance>/send: post a reply into a thread the inbound half has seen; `platform` is that thread's o_threads.platform. */
  send(env: Env, door: DoorConfig, instance: string, platform: Record<string, unknown>, reply: DoorReply): Promise<SendOutcome>;
  /** POST /v1/door/<kind>/<instance>/notify: start a conversation with one member; returns the thread the member's reply will come back on. */
  notify(env: Env, door: DoorConfig, instance: string, subjectId: string, reply: DoorReply): Promise<NotifyOutcome>;
  /** After a successful send: clear an activity indicator, for example. Best effort. */
  afterSend?(env: Env, door: DoorConfig, threadId: string, platform: Record<string, unknown>): Promise<void>;
  /** Extra platform-facing routes, POST /door/<kind>/<instance>/<action>. */
  routes?: Record<string, DoorRouteHandler>;
}

export function findDoor(env: Env, kind: string, instance: string): DoorConfig | undefined {
  return parseKaltraConfig(env.KALTRA_CONFIG).doors.find((d) => d.kind === kind && d.instance === instance);
}

/** The v0 HMAC scheme (`v0=` hex of HMAC-SHA256 over `v0:<timestamp>:<body>`), Slack's and the dev door's, with a clock skew window. */
export async function verifyV0Signature(secret: string, timestamp: string | null, signature: string | null, body: ArrayBuffer, now = Math.floor(Date.now() / 1000), skewSeconds = V0_SKEW_SECONDS): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > skewSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`v0:${timestamp}:`);
  const base = new Uint8Array(prefix.length + body.byteLength);
  base.set(prefix, 0);
  base.set(new Uint8Array(body), prefix.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, base));
  const expected = new TextEncoder().encode(`v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  const given = new TextEncoder().encode(signature);
  if (expected.byteLength !== given.byteLength) return false;
  return crypto.subtle.timingSafeEqual(expected, given);
}

export async function lookupThread(db: D1Database, doorKind: string, instance: string, platformKey: string): Promise<string | null> {
  const row = await db.prepare("SELECT thread_id FROM o_threads WHERE door_kind = ?1 AND instance = ?2 AND platform_key = ?3 AND expires_at > ?4").bind(doorKind, instance, platformKey, Math.floor(Date.now() / 1000)).first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/** The thread id for a platform key: the one it already has (TTL refreshed), else a new row. */
export async function threadIdFor(db: D1Database, doorKind: string, instance: string, platformKey: string, platform: Record<string, unknown>, now: number): Promise<string> {
  const existing = await db.prepare("SELECT thread_id FROM o_threads WHERE door_kind = ?1 AND instance = ?2 AND platform_key = ?3").bind(doorKind, instance, platformKey).first<{ thread_id: string }>();
  if (existing) {
    await db.prepare("UPDATE o_threads SET expires_at = ?1 WHERE thread_id = ?2").bind(now + THREAD_TTL_SECONDS, existing.thread_id).run();
    return existing.thread_id;
  }
  const threadId = crypto.randomUUID();
  await db.prepare("INSERT INTO o_threads (thread_id, door_kind, instance, platform_key, platform, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(threadId, doorKind, instance, platformKey, JSON.stringify(platform), now + THREAD_TTL_SECONDS).run();
  return threadId;
}
