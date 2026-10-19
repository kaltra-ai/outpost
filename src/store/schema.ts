// Outpost-owned tables (docs/protocol-v1.md section 7, the o_* namespace).
// The outpost owns and migrates this schema itself, versioned in o_meta, so an outpost upgrade never needs an operator step.

export const OUTPOST_SCHEMA_VERSION = 4;

const MIGRATIONS: Record<number, string[]> = {
  1: [
    "CREATE TABLE IF NOT EXISTS o_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS o_nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (key_id, nonce))",
    "CREATE TABLE IF NOT EXISTS o_idempotency (route TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, status INTEGER NOT NULL, response_body TEXT, response_truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (route, key))",
    "CREATE TABLE IF NOT EXISTS o_audit (request_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, route TEXT NOT NULL, actor TEXT NOT NULL, key_id TEXT, protocol_version TEXT, engine_version TEXT, outpost_version TEXT NOT NULL, credential_name TEXT, instance_id TEXT, host TEXT, statement_hash TEXT, sql_template TEXT, member_subject_id TEXT, bytes_in INTEGER, bytes_out INTEGER, tokens_in INTEGER, tokens_out INTEGER, model TEXT, duration_ms INTEGER, status INTEGER NOT NULL, error_code TEXT, duplicate INTEGER NOT NULL DEFAULT 0, cf_ray TEXT)",
    "CREATE TABLE IF NOT EXISTS o_inbound (door_kind TEXT NOT NULL, instance TEXT NOT NULL, event_id TEXT NOT NULL, envelope TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (door_kind, instance, event_id))",
    "CREATE TABLE IF NOT EXISTS o_threads (thread_id TEXT PRIMARY KEY, door_kind TEXT NOT NULL, instance TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS o_attachments (ref TEXT PRIMARY KEY, door_kind TEXT NOT NULL, instance TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ],
  // Threads gain a platform key so one conversation always maps to one thread id. Threads are ephemeral (24 h), so recreate.
  2: [
    "DROP TABLE IF EXISTS o_threads",
    "CREATE TABLE o_threads (thread_id TEXT PRIMARY KEY, door_kind TEXT NOT NULL, instance TEXT NOT NULL, platform_key TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    "CREATE UNIQUE INDEX o_threads_platform ON o_threads (door_kind, instance, platform_key)",
  ],
  // Dev door replies (operator QA door), polled by the caller.
  3: [
    "CREATE TABLE IF NOT EXISTS o_dev_replies (instance TEXT NOT NULL, dev_thread TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (instance, dev_thread, seq))",
  ],
  // Audit rows get an outpost-minted primary key: the engine-minted request_id can no longer overwrite an earlier row (review 2026-09-23, finding 1).
  4: [
    "ALTER TABLE o_audit RENAME TO o_audit_v3",
    "CREATE TABLE o_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, ts INTEGER NOT NULL, route TEXT NOT NULL, actor TEXT NOT NULL, key_id TEXT, protocol_version TEXT, engine_version TEXT, outpost_version TEXT NOT NULL, credential_name TEXT, instance_id TEXT, host TEXT, statement_hash TEXT, sql_template TEXT, member_subject_id TEXT, bytes_in INTEGER, bytes_out INTEGER, tokens_in INTEGER, tokens_out INTEGER, model TEXT, duration_ms INTEGER, status INTEGER NOT NULL, error_code TEXT, duplicate INTEGER NOT NULL DEFAULT 0, cf_ray TEXT)",
    "INSERT INTO o_audit (request_id, ts, route, actor, key_id, protocol_version, engine_version, outpost_version, credential_name, instance_id, host, statement_hash, sql_template, member_subject_id, bytes_in, bytes_out, tokens_in, tokens_out, model, duration_ms, status, error_code, duplicate, cf_ray) SELECT request_id, ts, route, actor, key_id, protocol_version, engine_version, outpost_version, credential_name, instance_id, host, statement_hash, sql_template, member_subject_id, bytes_in, bytes_out, tokens_in, tokens_out, model, duration_ms, status, error_code, duplicate, cf_ray FROM o_audit_v3 ORDER BY ts",
    "DROP TABLE o_audit_v3",
    "CREATE INDEX o_audit_request ON o_audit (request_id)",
    "CREATE INDEX o_audit_ts ON o_audit (ts)",
  ],
};

const META_DDL = "CREATE TABLE IF NOT EXISTS o_meta (id INTEGER PRIMARY KEY CHECK (id = 1), outpost_schema_version INTEGER NOT NULL)";

// Per-isolate memo: configuration state, not request state.
const ensured = new WeakSet<D1Database>();

export async function ensureOutpostSchema(db: D1Database, opts: { force?: boolean } = {}): Promise<void> {
  if (ensured.has(db) && !opts.force) return;
  await db.prepare(META_DDL).run();
  const row = await db.prepare("SELECT outpost_schema_version FROM o_meta WHERE id = 1").first<{ outpost_schema_version: number }>();
  let current = row?.outpost_schema_version ?? 0;
  while (current < OUTPOST_SCHEMA_VERSION) {
    const next = current + 1;
    await db.batch([
      ...MIGRATIONS[next].map((s) => db.prepare(s)),
      db.prepare("INSERT INTO o_meta (id, outpost_schema_version) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET outpost_schema_version = ?1").bind(next),
    ]);
    current = next;
  }
  ensured.add(db);
}

export async function appliedSchemaVersion(db: D1Database): Promise<number | null> {
  await ensureOutpostSchema(db);
  const row = await db.prepare("SELECT version FROM o_schema WHERE id = 1").first<{ version: number }>();
  return row?.version ?? null;
}
