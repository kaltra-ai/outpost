import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import { ensureOutpostSchema } from "../src/store/schema";
import { call } from "./helpers";

const SECRET = "dev-door-test-secret";
const BASE = "https://outpost.test.invalid";

async function hmac(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  return { "content-type": "application/json", "x-kaltra-dev-timestamp": String(ts), "x-kaltra-dev-signature": `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}` };
}

describe("dev door: POST /door/dev/qa", () => {
  it("refuses a bad signature and an unconfigured instance", async () => {
    const body = JSON.stringify({ subject_id: "UDEV", text: "hello", thread_id: "dev-1" });
    const bad = await SELF.fetch(`${BASE}/door/dev/qa`, { method: "POST", headers: await hmac(body, undefined, "wrong"), body });
    expect(bad.status).toBe(401);
    const none = await SELF.fetch(`${BASE}/door/dev/nope`, { method: "POST", headers: await hmac(body), body });
    expect(none.status).toBe(404);
  });

  it("builds the same envelope a platform door would, stores it, enqueues the event id, and returns the event id", async () => {
    await ensureOutpostSchema(env.STORE);
    const body = JSON.stringify({ subject_id: "UDEV", display_name: "Dev", text: "answer me in French", thread_id: "dev-1", groups: ["directors"] });
    const res = await SELF.fetch(`${BASE}/door/dev/qa`, { method: "POST", headers: await hmac(body), body });
    expect(res.status).toBe(202);
    const { event_id } = (await res.json()) as { event_id: string };
    const row = await env.STORE.prepare("SELECT envelope FROM o_inbound WHERE door_kind = 'dev' AND instance = 'qa' AND event_id = ?1").bind(event_id).first<{ envelope: string }>();
    const envelope = JSON.parse(row!.envelope) as Record<string, unknown>;
    expect(envelope).toMatchObject({ door: { kind: "dev", instance: "qa" }, scope: "personal", member: { subject_id: "UDEV", display_name: "Dev", groups: [{ provider: "dev", id: "directors" }] }, text: "answer me in French", addressed_to_bot: true });
    expect(typeof envelope.thread_id).toBe("string");
  });
});

describe("dev door: replies", () => {
  it("stores what the engine sends to a dev thread and returns it to a signed poll", async () => {
    await ensureOutpostSchema(env.STORE);
    const body = JSON.stringify({ subject_id: "UDEV", text: "hi", thread_id: "dev-2" });
    const posted = await SELF.fetch(`${BASE}/door/dev/qa`, { method: "POST", headers: await hmac(body), body });
    const { event_id, thread_id } = (await posted.json()) as { event_id: string; thread_id: string };

    const send = await call("/v1/door/dev/qa/send", { method: "POST", body: { request_id: crypto.randomUUID(), idempotency_key: `send:dev:qa:${event_id}`, thread_id, text: "Bonjour.", format: "markdown", actions: [] } });
    expect(send.status).toBe(200);

    const q = JSON.stringify({ thread_id: "dev-2", after: 0 });
    const poll = await SELF.fetch(`${BASE}/door/dev/qa/replies`, { method: "POST", headers: await hmac(q), body: q });
    expect(poll.status).toBe(200);
    const replies = (await poll.json()) as { replies: { text: string; seq: number }[] };
    expect(replies.replies.map((r) => r.text)).toEqual(["Bonjour."]);
  });
});

describe("dev door: notify", () => {
  it("stores a notification under notify:<subject_id> and a later dev message continues that thread", async () => {
    await ensureOutpostSchema(env.STORE);
    const res = await call("/v1/door/dev/qa/notify", { method: "POST", body: { request_id: crypto.randomUUID(), engine_version: "0.1.0", idempotency_key: crypto.randomUUID(), subject_id: "UDEV", text: "Weekly digest: three items.", format: "markdown" } });
    expect(res.status).toBe(200);
    expect(typeof res.json.thread_id).toBe("string");
    expect(res.json.platform_message_id).toBe("1");

    const q = JSON.stringify({ thread_id: "notify:UDEV", after: 0 });
    const poll = await SELF.fetch(`${BASE}/door/dev/qa/replies`, { method: "POST", headers: await hmac(q), body: q });
    const replies = (await poll.json()) as { replies: { text: string; seq: number }[] };
    expect(replies.replies.map((r) => r.text)).toEqual(["Weekly digest: three items."]);

    const body = JSON.stringify({ subject_id: "UDEV", text: "tell me more about item two", thread_id: "notify:UDEV" });
    const posted = await SELF.fetch(`${BASE}/door/dev/qa`, { method: "POST", headers: await hmac(body), body });
    expect(posted.status).toBe(202);
    const { thread_id } = (await posted.json()) as { thread_id: string };
    expect(thread_id).toBe(res.json.thread_id);
  });
});
