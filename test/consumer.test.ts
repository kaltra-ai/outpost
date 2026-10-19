import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { ensureOutpostSchema } from "../src/store/schema";
import { verifyRequest } from "../src/signature";
import { engineKeys } from "../src/config";
import outpostKey from "./fixtures/outpost-test-key.json";

type Msg = { event_id: string; door_kind: string; instance: string };
function fakeMessage(body: Msg, attempts = 1) {
  const calls: { ack: number; retry: { delaySeconds?: number }[] } = { ack: 0, retry: [] };
  const msg = { id: "m1", timestamp: new Date(), body, attempts, ack: () => { calls.ack++; }, retry: (o?: { delaySeconds?: number }) => { calls.retry.push(o ?? {}); } };
  return { msg, calls };
}
function batchOf(msg: unknown): MessageBatch<Msg> {
  return { queue: "kaltra-inbound", messages: [msg as Message<Msg>], metadata: undefined, ackAll() {}, retryAll() {} } as unknown as MessageBatch<Msg>;
}

async function seedInbound(eventId: string) {
  await ensureOutpostSchema(env.STORE);
  const now = Math.floor(Date.now() / 1000);
  const threadId = "th-" + eventId;
  await env.STORE.batch([
    env.STORE.prepare("INSERT INTO o_threads (thread_id, door_kind, instance, platform_key, platform, expires_at) VALUES (?1, 'slack', 'main', ?2, ?3, ?4)").bind(threadId, `D1:${eventId}`, JSON.stringify({ channel: "D1", thread_ts: eventId, channel_type: "im" }), now + 3600),
    env.STORE.prepare("INSERT INTO o_inbound (door_kind, instance, event_id, envelope, received_at, expires_at) VALUES ('slack', 'main', ?1, ?2, ?3, ?4)").bind(eventId, JSON.stringify({ event_id: eventId, door: { kind: "slack", instance: "main" }, thread_id: threadId, text: "hi" }), now, now + 3600),
  ]);
}

afterEach(() => vi.unstubAllGlobals());

describe("queue consumer", () => {
  it("posts the envelope to the engine, signed with the outpost key, and acks on 200", async () => {
    const eventId = "Ev" + crypto.randomUUID().slice(0, 8);
    await seedInbound(eventId);
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => { const r = input instanceof Request ? input : new Request(input, init); seen.push(r.clone()); return Response.json({ request_id: "x" }); });
    const { msg, calls } = fakeMessage({ event_id: eventId, door_kind: "slack", instance: "main" });
    await worker.queue(batchOf(msg), env);

    expect(calls).toEqual({ ack: 1, retry: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://engine.test.invalid/v1/inbound");
    expect(seen[0].method).toBe("POST");
    const body = await seen[0].clone().arrayBuffer();
    const verified = await verifyRequest(seen[0], body, { keys: await engineKeys(JSON.stringify([{ key_id: outpostKey.key_id, public_key: outpostKey.public_key_raw_b64url }])), expectedProtocol: "1.1" });
    expect(verified.ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({ event_id: eventId, text: "hi" });
  });

  it("retries with the documented delay when the engine fails", async () => {
    const eventId = "Ev" + crypto.randomUUID().slice(0, 8);
    await seedInbound(eventId);
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));
    const { msg, calls } = fakeMessage({ event_id: eventId, door_kind: "slack", instance: "main" }, 3);
    await worker.queue(batchOf(msg), env);
    expect(calls).toEqual({ ack: 0, retry: [{ delaySeconds: 60 }] });
  });

  it("posts the unavailable line through the door module on the final attempt, then lets the message fall to the dead-letter queue", async () => {
    const eventId = "Ev" + crypto.randomUUID().slice(0, 8);
    await ensureOutpostSchema(env.STORE);
    const now = Math.floor(Date.now() / 1000);
    const threadId = "th-" + eventId;
    await env.STORE.batch([
      env.STORE.prepare("INSERT INTO o_threads (thread_id, door_kind, instance, platform_key, platform, expires_at) VALUES (?1, 'dev', 'qa', ?2, ?3, ?4)").bind(threadId, `dev:${eventId}`, JSON.stringify({ dev_thread: eventId }), now + 3600),
      env.STORE.prepare("INSERT INTO o_inbound (door_kind, instance, event_id, envelope, received_at, expires_at) VALUES ('dev', 'qa', ?1, ?2, ?3, ?4)").bind(eventId, JSON.stringify({ event_id: eventId, door: { kind: "dev", instance: "qa" }, thread_id: threadId, text: "hi" }), now, now + 3600),
    ]);
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 503 }));
    const { msg, calls } = fakeMessage({ event_id: eventId, door_kind: "dev", instance: "qa" }, 7);
    await worker.queue(batchOf(msg), env);
    const stored = await env.STORE.prepare("SELECT text FROM o_dev_replies WHERE instance = 'qa' AND dev_thread = ?1").bind(eventId).first<{ text: string }>();
    expect(stored?.text).toBe("I cannot reach the brain right now. I will try again later.");
    expect(calls.ack).toBe(0);
    expect(calls.retry).toHaveLength(1);
  });

  it("acks a message whose envelope is gone (expired or wiped) instead of retrying forever", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { msg, calls } = fakeMessage({ event_id: "nope", door_kind: "slack", instance: "main" });
    await worker.queue(batchOf(msg), env);
    expect(calls).toEqual({ ack: 1, retry: [] });
  });
});
