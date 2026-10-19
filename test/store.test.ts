import { describe, it, expect } from "vitest";
import { call, migrateTo } from "./helpers";
import { ensureOutpostSchema } from "../src/store/schema";

describe("POST /v1/store/migrate", () => {
  it("applies engine DDL and records the new schema version, which meta then reports", async () => {
    const res = await migrateTo(1, null, ["CREATE TABLE k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"]);
    expect(res.status).toBe(200);
    expect(res.json.schema_version).toBe(1);

    const meta = await call("/v1/meta");
    expect(meta.json.schema_version).toBe(1);
  });
});

describe("POST /v1/store/migrate refusals", () => {
  it("refuses when the expected schema version does not match the applied one", async () => {
    await migrateTo(1, null, ["CREATE TABLE IF NOT EXISTS k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"]);
    const res = await migrateTo(2, 0, ["CREATE TABLE k_members (subject_id TEXT PRIMARY KEY)"]);
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe("schema_version_mismatch");
  });

  it("refuses DDL that names an outpost-owned table or creates a trigger", async () => {
    const onOutpost = await migrateTo(9, null, ["DROP TABLE o_audit"]);
    const trigger = await migrateTo(9, null, ["CREATE TRIGGER k_t AFTER INSERT ON k_items_shared BEGIN SELECT 1; END"]);
    expect(onOutpost.json.error?.code).toBe("statement_not_allowed");
    expect(trigger.json.error?.code).toBe("statement_not_allowed");
  });
});

async function query(mode: "read" | "write", statements: { sql: string; params?: unknown[] }[], extra: Record<string, unknown> = {}) {
  return call("/v1/store/query", {
    method: "POST",
    body: { request_id: crypto.randomUUID(), ...(mode === "write" ? { idempotency_key: crypto.randomUUID() } : {}), mode, statements, ...extra },
  });
}

describe("POST /v1/store/query", () => {
  it("writes rows in write mode and reads them back in read mode", async () => {
    await migrateTo(1, null, ["CREATE TABLE IF NOT EXISTS k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"]);
    const w = await query("write", [{ sql: "INSERT INTO k_items_shared (id, text) VALUES (?1, ?2)", params: ["i1", "vacation carry-over ends in March"] }]);
    expect(w.status).toBe(200);
    expect((w.json.results as { changes: number }[])[0].changes).toBe(1);

    const r = await query("read", [{ sql: "SELECT id, text FROM k_items_shared WHERE id = ?1", params: ["i1"] }]);
    expect(r.status).toBe(200);
    expect((r.json.results as { rows: unknown[] }[])[0].rows).toEqual([{ id: "i1", text: "vacation carry-over ends in March" }]);
    expect(typeof r.json.session_bookmark).toBe("string");
  });

  it("refuses a statement that names an outpost-owned table, even in read mode", async () => {
    const res = await query("read", [{ sql: "SELECT * FROM o_audit" }]);
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("statement_not_allowed");
  });

  it("refuses PRAGMA and multi-statement entries", async () => {
    const pragma = await query("read", [{ sql: "PRAGMA table_info(k_items_shared)" }]);
    const multi = await query("read", [{ sql: "SELECT 1; SELECT 2" }]);
    expect(pragma.json.error?.code).toBe("statement_not_allowed");
    expect(multi.json.error?.code).toBe("statement_not_allowed");
  });

  it("refuses a write statement submitted in read mode", async () => {
    const res = await query("read", [{ sql: "DELETE FROM k_items_shared" }]);
    expect(res.json.error?.code).toBe("statement_not_allowed");
  });

  it("refuses a write without an idempotency key", async () => {
    const res = await call("/v1/store/query", { method: "POST", body: { request_id: crypto.randomUUID(), mode: "write", statements: [{ sql: "DELETE FROM k_items_shared" }] } });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("invalid_request");
  });
});

import { SELF, env } from "cloudflare:test";
import { signed } from "./helpers";

describe("replay, idempotency, audit", () => {
  const ddl = ["CREATE TABLE IF NOT EXISTS k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"];

  it("rejects a second delivery of the same signed write (same nonce)", async () => {
    await migrateTo(1, null, ddl);
    const req = await signed("/v1/store/query", {
      method: "POST", nonce: "replay-nonce-" + crypto.randomUUID(),
      body: { request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), mode: "write", statements: [{ sql: "INSERT INTO k_items_shared (id, text) VALUES (?1, ?2)", params: [crypto.randomUUID(), "x"] }] },
    });
    const first = await SELF.fetch(req.clone());
    const second = await SELF.fetch(req);
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it("returns the stored response for a repeated idempotency key with the same body, and conflicts on a different body", async () => {
    await migrateTo(1, null, ddl);
    const key = crypto.randomUUID();
    const id = crypto.randomUUID();
    const body = { request_id: crypto.randomUUID(), idempotency_key: key, mode: "write", statements: [{ sql: "INSERT INTO k_items_shared (id, text) VALUES (?1, ?2)", params: [id, "once"] }] };
    const first = await call("/v1/store/query", { method: "POST", body });
    const again = await call("/v1/store/query", { method: "POST", body });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.results).toEqual(first.json.results);
    const rows = await query("read", [{ sql: "SELECT count(*) AS n FROM k_items_shared WHERE id = ?1", params: [id] }]);
    expect((rows.json.results as { rows: { n: number }[] }[])[0].rows[0].n).toBe(1);

    const conflict = await call("/v1/store/query", { method: "POST", body: { ...body, statements: [{ sql: "DELETE FROM k_items_shared" }] } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error?.code).toBe("idempotency_conflict");
  });

  it("writes one audit row per store call, with the SQL template for writes and only a hash for reads", async () => {
    await migrateTo(1, null, ddl);
    const writeId = crypto.randomUUID();
    await call("/v1/store/query", { method: "POST", body: { request_id: writeId, idempotency_key: crypto.randomUUID(), mode: "write", statements: [{ sql: "INSERT INTO k_items_shared (id, text) VALUES (?1, ?2)", params: [crypto.randomUUID(), "secret text"] }] } });
    const readId = crypto.randomUUID();
    await call("/v1/store/query", { method: "POST", body: { request_id: readId, mode: "read", statements: [{ sql: "SELECT text FROM k_items_shared" }] } });

    const w = await env.STORE.prepare("SELECT route, actor, key_id, sql_template, statement_hash, status FROM o_audit WHERE request_id = ?1").bind(writeId).first<Record<string, unknown>>();
    const r = await env.STORE.prepare("SELECT route, sql_template, statement_hash, status FROM o_audit WHERE request_id = ?1").bind(readId).first<Record<string, unknown>>();
    expect(w).toMatchObject({ route: "/v1/store/query", actor: "engine", key_id: "engine-test-k1", status: 200 });
    expect(w?.sql_template).toContain("INSERT INTO k_items_shared");
    expect(w?.sql_template).not.toContain("secret text");
    expect(r).toMatchObject({ route: "/v1/store/query", sql_template: null, status: 200 });
    expect(typeof r?.statement_hash).toBe("string");
  });
});

describe("engine statement failures", () => {
  const ddl = ["CREATE TABLE IF NOT EXISTS k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"];

  it("returns statement_failed with the SQLite code when a write violates the engine's own constraint, and rolls back", async () => {
    await migrateTo(1, null, ddl);
    const id = crypto.randomUUID();
    const insert = (key: string) => query("write", [{ sql: "INSERT INTO k_items_shared (id, text) VALUES (?1, ?2)", params: [id, "first"] }], { idempotency_key: key });
    expect((await insert(crypto.randomUUID())).status).toBe(200);
    const dup = await insert(crypto.randomUUID());
    expect(dup.status).toBe(422);
    expect(dup.json.error).toMatchObject({ code: "statement_failed", retryable: false, sqlite_code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
    expect(JSON.stringify(dup.json)).not.toContain("k_items_shared.id");

    const rows = await query("read", [{ sql: "SELECT count(*) AS n FROM k_items_shared WHERE id = ?1", params: [id] }]);
    expect((rows.json.results as { rows: { n: number }[] }[])[0].rows[0].n).toBe(1);
  });

  it("returns statement_failed for a read against a table the engine never created", async () => {
    const res = await query("read", [{ sql: "SELECT * FROM k_does_not_exist" }]);
    expect(res.status).toBe(422);
    expect(res.json.error).toMatchObject({ code: "statement_failed", sqlite_code: "SQLITE_ERROR" });
  });
});

describe("guard accepts the engine's upsert syntax", () => {
  it("allows INSERT ... ON CONFLICT DO UPDATE SET on an engine table in write mode", async () => {
    // D1 state persists across tests in a file: migrate from whatever version the store is at.
    const current = (await call("/v1/meta")).json.schema_version as number | null;
    const mig = await migrateTo((current ?? 0) + 1, current, ["CREATE TABLE IF NOT EXISTS k_members (door_kind TEXT, subject_id TEXT, last_seen INTEGER, PRIMARY KEY (door_kind, subject_id))"]);
    expect(mig.status).toBe(200);
    const res = await query("write", [{ sql: "INSERT INTO k_members (door_kind, subject_id, last_seen) VALUES (?1, ?2, ?3) ON CONFLICT (door_kind, subject_id) DO UPDATE SET last_seen = ?3", params: ["slack", "U1", 1] }]);
    expect(res.status).toBe(200);
    const again = await query("write", [{ sql: "INSERT INTO k_members (door_kind, subject_id, last_seen) VALUES (?1, ?2, ?3) ON CONFLICT (door_kind, subject_id) DO UPDATE SET last_seen = ?3", params: ["slack", "U1", 2] }]);
    expect(again.status).toBe(200);
  });
});

describe("migrate accepts seed rows", () => {
  it("applies a DDL batch that ends with an INSERT into an engine table", async () => {
    const current = (await call("/v1/meta")).json.schema_version as number | null;
    const res = await migrateTo((current ?? 0) + 1, current, [
      "CREATE TABLE IF NOT EXISTS k_meta (id INTEGER PRIMARY KEY CHECK (id = 1), memory_format_version INTEGER NOT NULL)",
      "INSERT INTO k_meta (id, memory_format_version) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET memory_format_version = 1",
    ]);
    expect(res.status).toBe(200);
    const row = await query("read", [{ sql: "SELECT memory_format_version FROM k_meta WHERE id = 1" }]);
    expect((row.json.results as { rows: { memory_format_version: number }[] }[])[0].rows[0].memory_format_version).toBe(1);
  });

  it("still refuses a migrate that writes an outpost table", async () => {
    const current = (await call("/v1/meta")).json.schema_version as number | null;
    const res = await migrateTo((current ?? 0) + 1, current, ["DELETE FROM o_audit"]);
    expect(res.json.error?.code).toBe("statement_not_allowed");
  });
});

describe("review 2026-09-23 fixes: store gateway", () => {
  it("refuses a write verb hidden in a read-mode statement, and pragma_ table functions", async () => {
    const { guardStatement } = await import("../src/store/guard");
    expect(guardStatement("WITH t AS (SELECT 1) DELETE FROM k_items_shared", ["read"])).toMatchObject({ ok: false, reason: "write_in_read" });
    expect(guardStatement("SELECT * FROM k_items_shared WHERE text = 'delete me'", ["read"])).toMatchObject({ ok: true });
    expect(guardStatement("SELECT updated_at FROM k_items_shared", ["read"])).toMatchObject({ ok: true });
    expect(guardStatement("SELECT * FROM pragma_table_info('o_audit')", ["read"])).toMatchObject({ ok: false });
    const cte = await query("read", [{ sql: "WITH t AS (SELECT 1) DELETE FROM k_items_shared" }]);
    expect(cte.json.error?.code).toBe("statement_not_allowed");
  });

  it("never overwrites an audit row: two calls reusing one request id leave two rows", async () => {
    const rid = "reuse-" + crypto.randomUUID();
    await ensureOutpostSchema(env.STORE);
    await env.STORE.prepare("CREATE TABLE IF NOT EXISTS k_probe (id TEXT PRIMARY KEY)").run();
    await call("/v1/store/query", { method: "POST", body: { request_id: rid, mode: "write", idempotency_key: crypto.randomUUID(), statements: [{ sql: "INSERT INTO k_probe (id) VALUES (?1)", params: [crypto.randomUUID()] }] } });
    await call("/v1/store/query", { method: "POST", body: { request_id: rid, mode: "read", statements: [{ sql: "SELECT 1" }] } });
    const rows = await env.STORE.prepare("SELECT route, sql_template FROM o_audit WHERE request_id = ?1 ORDER BY id").bind(rid).all<{ route: string; sql_template: string | null }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(2);
    expect(rows.results.some((r) => r.sql_template !== null && r.sql_template.includes("INSERT INTO k_probe"))).toBe(true);
  });

  it("answers a replay of a half-recorded write (status 0) with 200 and response_lost, never a 500", async () => {
    await ensureOutpostSchema(env.STORE);
    await env.STORE.prepare("CREATE TABLE IF NOT EXISTS k_probe (id TEXT PRIMARY KEY)").run();
    const key = "half-" + crypto.randomUUID();
    const body = { request_id: crypto.randomUUID(), mode: "write", idempotency_key: key, statements: [{ sql: "INSERT INTO k_probe (id) VALUES (?1)", params: [crypto.randomUUID()] }] };
    const first = await call("/v1/store/query", { method: "POST", body });
    expect(first.status).toBe(200);
    await env.STORE.prepare("UPDATE o_idempotency SET status = 0, response_body = NULL WHERE key = ?1").bind(key).run();
    const replay = await call("/v1/store/query", { method: "POST", body });
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ duplicate: true, response_lost: true });
  });
});
