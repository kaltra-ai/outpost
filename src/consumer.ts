// Queue consumer (protocol section 8): carry a claim-checked envelope to the engine, synchronously, with the retry schedule.

import { signRequest } from "./signature";
import { OUTPOST_VERSION } from "./config";
import { ensureOutpostSchema } from "./store/schema";
import { findDoor } from "./doors/sdk";
import { doorModule } from "./doors/registry";
import { loadThread } from "./routes/door-send";

export const RETRY_SCHEDULE_SECONDS = [1, 10, 60, 300, 600, 900] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1; // max_retries: 6 in wrangler.jsonc
const ENGINE_TIMEOUT_MS = 10 * 60 * 1000;

export interface InboundMessage { event_id: string; door_kind: string; instance: string }

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function outpostPrivateKey(env: Env): Promise<CryptoKey> {
  const raw = (env as unknown as Record<string, unknown>).KALTRA_OUTPOST_PRIVATE_KEY;
  if (typeof raw !== "string" || raw.length === 0) throw new Error("KALTRA_OUTPOST_PRIVATE_KEY is not set");
  return crypto.subtle.importKey("pkcs8", base64urlToBytes(raw), { name: "Ed25519" }, false, ["sign"]);
}

export async function deliver(env: Env, msg: Message<InboundMessage>): Promise<void> {
  const db = env.STORE;
  await ensureOutpostSchema(db);
  const { event_id, door_kind, instance } = msg.body;
  const row = await db.prepare("SELECT envelope FROM o_inbound WHERE door_kind = ?1 AND instance = ?2 AND event_id = ?3").bind(door_kind, instance, event_id).first<{ envelope: string }>();
  if (!row) { msg.ack(); return; } // expired or wiped: nothing left to deliver

  let ok = false;
  try {
    const req = await signRequest(
      new Request(`${env.KALTRA_ENGINE_URL}/v1/inbound`, { method: "POST", headers: { "content-type": "application/json", "Kaltra-Outpost-Version": OUTPOST_VERSION }, body: row.envelope }),
      { keyId: env.KALTRA_OUTPOST_KEY_ID, privateKey: await outpostPrivateKey(env), protocol: env.KALTRA_PROTOCOL },
    );
    const res = await fetch(req, { signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS) });
    ok = res.ok;
    if (!ok) console.log(JSON.stringify({ event: "engine_inbound_failed", event_id, status: res.status, attempt: msg.attempts }));
  } catch (e) {
    console.log(JSON.stringify({ event: "engine_inbound_failed", event_id, attempt: msg.attempts, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
  }
  if (ok) { msg.ack(); return; }

  if (msg.attempts >= MAX_ATTEMPTS) {
    await postUnavailable(env, row.envelope);
    msg.retry(); // exhausts max_retries and falls to the dead-letter queue
    return;
  }
  msg.retry({ delaySeconds: RETRY_SCHEDULE_SECONDS[Math.min(msg.attempts - 1, RETRY_SCHEDULE_SECONDS.length - 1)] });
}

async function postUnavailable(env: Env, envelopeJson: string): Promise<void> {
  try {
    const envelope = JSON.parse(envelopeJson) as { thread_id?: string; door?: { kind?: string; instance?: string } };
    if (!envelope.thread_id || !envelope.door?.kind || !envelope.door.instance) return;
    const thread = await loadThread(env, envelope.thread_id);
    const door = findDoor(env, envelope.door.kind, envelope.door.instance);
    if (!thread || !door) return;
    const module = doorModule(envelope.door.kind);
    if (!module) return;
    await module.send(env, door, envelope.door.instance, thread.platform, { text: env.KALTRA_UNAVAILABLE_TEXT, format: "plain" });
    if (module.afterSend) await module.afterSend(env, door, envelope.thread_id, thread.platform);
  } catch (e) {
    console.log(JSON.stringify({ event: "unavailable_line_failed", error: e instanceof Error ? e.name : String(e) }));
  }
}
