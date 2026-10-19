import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { ensureOutpostSchema } from "../src/store/schema";
import { call } from "./helpers";

async function count(table: string, where = "1=1"): Promise<number> {
  const row = await env.STORE.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("scheduled cleanup", () => {
  it("purges nonces older than 15 minutes and idempotency rows older than 7 days, keeps fresh ones", async () => {
    await ensureOutpostSchema(env.STORE);
    const now = Math.floor(Date.now() / 1000);
    await env.STORE.batch([
      env.STORE.prepare("INSERT INTO o_nonces (key_id, nonce, seen_at) VALUES ('k', 'old', ?1), ('k', 'fresh', ?2)").bind(now - 16 * 60, now - 60),
      env.STORE.prepare("INSERT INTO o_idempotency (route, key, request_hash, status, response_body, created_at) VALUES ('/r', 'old', 'h', 200, '{}', ?1), ('/r', 'fresh', 'h', 200, '{}', ?2)").bind(now - 8 * 86400, now - 3600),
    ]);
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: Date.now(), cron: "17 * * * *", noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await count("o_nonces", "nonce = 'old'")).toBe(0);
    expect(await count("o_nonces", "nonce = 'fresh'")).toBe(1);
    expect(await count("o_idempotency", "key = 'old'")).toBe(0);
    expect(await count("o_idempotency", "key = 'fresh'")).toBe(1);
  });
});

describe("meta audit", () => {
  it("writes an audit row for a meta call", async () => {
    const before = await count("o_audit", "route = '/v1/meta'");
    await call("/v1/meta");
    expect(await count("o_audit", "route = '/v1/meta'")).toBe(before + 1);
  });
});

describe("review 2026-09-23 fix: engine-side TTLs", () => {
  it("purges expired conversation turns, pending rows, old handled rows and old dev replies, and tolerates a store without k_* tables", async () => {
    const { cleanup } = await import("../src/cron");
    const { ensureOutpostSchema } = await import("../src/store/schema");
    const { env } = await import("cloudflare:test");
    await ensureOutpostSchema(env.STORE);
    for (const t of ["k_conversations", "k_pending", "k_handled"]) await env.STORE.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    await cleanup(env, 2_000_000_000); // no k_* tables: must not throw
    await env.STORE.batch([
      env.STORE.prepare("CREATE TABLE k_conversations (thread_id TEXT, seq INTEGER, role TEXT, text TEXT, event_id TEXT, created_at INTEGER, expires_at INTEGER)"),
      env.STORE.prepare("CREATE TABLE k_pending (thread_id TEXT, subject_id TEXT, kind TEXT, payload TEXT, created_at INTEGER, expires_at INTEGER)"),
      env.STORE.prepare("CREATE TABLE k_handled (door_kind TEXT, instance TEXT, event_id TEXT, claimed_at INTEGER, saved_at INTEGER, sent_at INTEGER)"),
      env.STORE.prepare("INSERT INTO k_conversations VALUES ('t', 1, 'member', 'old', 'e', 100, 200), ('t', 2, 'member', 'new', 'e2', 100, 9999999999)"),
      env.STORE.prepare("INSERT INTO k_pending VALUES ('t', 'u', 'scope', '{}', 100, 200), ('t2', 'u', 'scope', '{}', 100, 9999999999)"),
      env.STORE.prepare("INSERT INTO k_handled VALUES ('slack', 'main', 'old', 100, NULL, NULL), ('slack', 'main', 'new', 1999999999, NULL, NULL)"),
      env.STORE.prepare("INSERT INTO o_dev_replies (instance, dev_thread, seq, text, created_at) VALUES ('qa', 'd', 1, 'old', 100), ('qa', 'd', 2, 'new', 1999999999)"),
    ]);
    await cleanup(env, 2_000_000_000);
    const count = async (t: string) => (await env.STORE.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    expect(await count("k_conversations")).toBe(1);
    expect(await count("k_pending")).toBe(1);
    expect(await count("k_handled")).toBe(1);
    expect(await count("o_dev_replies")).toBe(1);
    for (const t of ["k_conversations", "k_pending", "k_handled"]) await env.STORE.prepare(`DROP TABLE ${t}`).run();
  });
});
