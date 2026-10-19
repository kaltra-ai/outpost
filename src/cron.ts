// Hourly housekeeping (docs/protocol-v1.md section 7). Every TTL here is the spec's number.
import { ensureOutpostSchema } from "./store/schema";

export const TTL = {
  nonces_s: 15 * 60,
  idempotency_s: 7 * 86_400,
  audit_default_s: 400 * 86_400,
  handled_s: 7 * 86_400,
  dev_replies_s: 7 * 86_400,
} as const;

export async function cleanup(env: Env, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  const db = env.STORE;
  await ensureOutpostSchema(db);
  await db.batch([
    db.prepare("DELETE FROM o_nonces WHERE seen_at < ?1").bind(nowSeconds - TTL.nonces_s),
    db.prepare("DELETE FROM o_idempotency WHERE created_at < ?1").bind(nowSeconds - TTL.idempotency_s),
    db.prepare("DELETE FROM o_inbound WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM o_threads WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM o_attachments WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM o_audit WHERE ts < ?1").bind(nowSeconds - TTL.audit_default_s),
  ]);
  // Engine-side rows carry their own expires_at (protocol section 7 assigns the purge to this cron); a store that predates the
  // engine migration has no k_* tables yet, so each statement runs alone and a missing table is not an error.
  const perTable = [
    db.prepare("DELETE FROM k_conversations WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM k_pending WHERE expires_at < ?1").bind(nowSeconds),
    db.prepare("DELETE FROM k_handled WHERE claimed_at < ?1").bind(nowSeconds - TTL.handled_s),
    db.prepare("DELETE FROM o_dev_replies WHERE created_at < ?1").bind(nowSeconds - TTL.dev_replies_s),
  ];
  for (const stmt of perTable) {
    try { await stmt.run(); } catch (e) {
      if (!(e instanceof Error && /no such table/.test(e.message))) throw e;
    }
  }
}
