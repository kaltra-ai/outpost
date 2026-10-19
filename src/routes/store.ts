import { errorResponse, type ErrorCode } from "../errors";
import { LIMITS, OUTPOST_VERSION } from "../config";
import { guardStatement } from "../store/guard";
import { appliedSchemaVersion, ensureOutpostSchema } from "../store/schema";
import { auditStatement, sha256Hex } from "../store/audit";
import type { RouteContext } from "../context";

const ROW_CAP = 10_000;
const NONCE_TTL_SECONDS = 15 * 60;
const IDEMPOTENCY_RESPONSE_CAP = 65_536;

type Json = Record<string, unknown>;

function parseJson(body: ArrayBuffer): Json | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(body)) as unknown;
    return typeof v === "object" && v !== null ? (v as Json) : null;
  } catch {
    return null;
  }
}

function isDuplicateNonce(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: o_nonces/.test(e.message);
}

/** The SQLite result code from a D1 error, never its message (messages can name columns). */
function sqliteCode(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.match(/\(extended: (SQLITE_[A-Z_]+)\)/)?.[1] ?? msg.match(/(SQLITE_[A-Z_]+)/)?.[1] ?? "SQLITE_UNKNOWN";
}

/** Runs a state-changing batch: nonce + idempotency row + the statements, atomically. Then records the response. */
async function runStateChange(
  ctx: RouteContext,
  key: string,
  requestHash: string,
  statements: D1PreparedStatement[],
): Promise<{ kind: "ran"; results: D1Result[] } | { kind: "replayed"; status: number; body: string | null } | { kind: "error"; code: ErrorCode; sqlite_code?: string }> {
  const db = ctx.env.STORE;
  const existing = await db
    .prepare("SELECT request_hash, status, response_body FROM o_idempotency WHERE route = ?1 AND key = ?2")
    .bind(ctx.route, key)
    .first<{ request_hash: string; status: number; response_body: string | null }>();
  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    // A repeat still consumes its nonce: a byte-identical redelivery is a replay, a retry carries a fresh nonce.
    try {
      await db.prepare("INSERT INTO o_nonces (key_id, nonce, seen_at) VALUES (?1, ?2, ?3)").bind(ctx.auth.keyId, ctx.auth.nonce, now).run();
    } catch (e) {
      if (isDuplicateNonce(e)) return { kind: "error", code: "unauthorized" };
      throw e;
    }
    if (existing.request_hash !== requestHash) return { kind: "error", code: "idempotency_conflict" };
    // status 0 means the batch committed but the response was never recorded (isolate died in between): the write happened.
    return { kind: "replayed", status: existing.status || 200, body: existing.status ? existing.response_body : null };
  }
  try {
    const out = await db.batch([
      db.prepare("INSERT INTO o_nonces (key_id, nonce, seen_at) VALUES (?1, ?2, ?3)").bind(ctx.auth.keyId, ctx.auth.nonce, now),
      db.prepare("INSERT INTO o_idempotency (route, key, request_hash, status, response_body, created_at) VALUES (?1, ?2, ?3, 0, NULL, ?4)").bind(ctx.route, key, requestHash, now),
      ...statements,
    ]);
    return { kind: "ran", results: out.slice(2) };
  } catch (e) {
    if (isDuplicateNonce(e)) return { kind: "error", code: "unauthorized" };
    // The batch rolled back as a whole (nonce, idempotency row, statements). Report the engine's failure, keep the outpost up.
    return { kind: "error", code: "statement_failed", sqlite_code: sqliteCode(e) };
  }
}

async function recordResponse(ctx: RouteContext, key: string, status: number, body: Json): Promise<void> {
  const text = JSON.stringify(body);
  const truncated = text.length > IDEMPOTENCY_RESPONSE_CAP;
  await ctx.env.STORE
    .prepare("UPDATE o_idempotency SET status = ?1, response_body = ?2, response_truncated = ?3 WHERE route = ?4 AND key = ?5")
    .bind(status, truncated ? null : text, truncated ? 1 : 0, ctx.route, key)
    .run();
}

async function finish(ctx: RouteContext, status: number, body: Json, audit: { sql_template?: string | null; statement_hash?: string | null; error_code?: string | null; duplicate?: boolean }): Promise<Response> {
  const res = Response.json(body, { status });
  await ctx.env.STORE.batch([
    auditStatement(ctx.env.STORE, {
      request_id: (body.request_id as string | undefined) ?? crypto.randomUUID(),
      route: ctx.route,
      actor: "engine",
      key_id: ctx.auth.keyId,
      protocol_version: ctx.auth.protocol,
      engine_version: (body.engine_version as string | undefined) ?? null,
      bytes_in: ctx.body.byteLength,
      duration_ms: Date.now() - ctx.startedAt,
      status,
      ...audit,
    }),
  ]);
  return res;
}

function fail(ctx: RouteContext, code: ErrorCode, request_id?: string, sqlite_code?: string): Promise<Response> {
  const res = errorResponse(code, { request_id, sqlite_code });
  return finish(ctx, res.status, { request_id: request_id ?? null, error: { code } }, { error_code: code }).then(() => res);
}

export async function migrate(ctx: RouteContext): Promise<Response> {
  const p = parseJson(ctx.body);
  if (!p) return fail(ctx, "invalid_request");
  const request_id = typeof p.request_id === "string" ? p.request_id : undefined;
  const key = p.idempotency_key;
  const expected = p.expected_schema_version;
  const target = p.target_schema_version;
  const statements = p.statements;
  if (
    request_id === undefined || typeof key !== "string" ||
    !(expected === null || Number.isInteger(expected)) || !Number.isInteger(target) ||
    !Array.isArray(statements) || statements.length === 0 || !statements.every((s) => typeof s === "string")
  ) {
    return fail(ctx, "invalid_request", request_id);
  }
  const ddl = statements as string[];
  // A migration is DDL plus the seed rows it needs (a meta row, a default config): writes on engine tables are allowed, reads are not.
  for (const sql of ddl) {
    if (!guardStatement(sql, ["ddl", "write"]).ok) return fail(ctx, "statement_not_allowed", request_id);
  }
  const db = ctx.env.STORE;
  await ensureOutpostSchema(db);
  const current = await appliedSchemaVersion(db);
  if (current !== expected) return fail(ctx, "schema_version_mismatch", request_id);

  const requestHash = await sha256Hex(ctx.body);
  const outcome = await runStateChange(ctx, key, requestHash, [
    ...ddl.map((s) => db.prepare(s)),
    db.prepare("INSERT INTO o_schema (id, version, applied_at) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET version = ?1, applied_at = ?2").bind(target, new Date().toISOString()),
  ]);
  if (outcome.kind === "error") return fail(ctx, outcome.code, request_id, outcome.sqlite_code);
  if (outcome.kind === "replayed") {
    const body = outcome.body ? (JSON.parse(outcome.body) as Json) : { request_id, outpost_version: OUTPOST_VERSION, schema_version: null, response_lost: true };
    return finish(ctx, outcome.status, { ...body, duplicate: true }, { sql_template: ddl.join("\n"), duplicate: true });
  }
  const body: Json = { request_id, outpost_version: OUTPOST_VERSION, schema_version: target };
  await recordResponse(ctx, key, 200, body);
  return finish(ctx, 200, body, { sql_template: ddl.join("\n") });
}

export async function query(ctx: RouteContext): Promise<Response> {
  const p = parseJson(ctx.body);
  if (!p) return fail(ctx, "invalid_request");
  const request_id = typeof p.request_id === "string" ? p.request_id : undefined;
  const mode = p.mode;
  const statements = p.statements;
  const isStmt = (s: unknown): s is { sql: string; params?: unknown[] } =>
    typeof s === "object" && s !== null && typeof (s as Json).sql === "string" && ((s as Json).params === undefined || Array.isArray((s as Json).params));
  if (
    request_id === undefined || (mode !== "read" && mode !== "write") ||
    !Array.isArray(statements) || statements.length === 0 || !statements.every(isStmt) ||
    (mode === "write" && typeof p.idempotency_key !== "string") ||
    (p.session_bookmark !== undefined && typeof p.session_bookmark !== "string")
  ) {
    return fail(ctx, "invalid_request", request_id);
  }
  const typed = statements as { sql: string; params?: unknown[] }[];
  if (typed.length > LIMITS.d1_statements_per_request) return fail(ctx, "payload_too_large", request_id);
  for (const s of typed) {
    if (s.sql.length > LIMITS.d1_statement_bytes || (s.params?.length ?? 0) > LIMITS.d1_params_per_statement) return fail(ctx, "payload_too_large", request_id);
    if (!guardStatement(s.sql, mode === "read" ? ["read"] : ["read", "write"]).ok) return fail(ctx, "statement_not_allowed", request_id);
  }
  const db = ctx.env.STORE;
  await ensureOutpostSchema(db);
  const templates = typed.map((s) => s.sql).join("\n");

  if (mode === "read") {
    const session = db.withSession((p.session_bookmark as string | undefined) ?? "first-unconstrained");
    let results: D1Result[];
    try {
      results = await session.batch(typed.map((s) => session.prepare(s.sql).bind(...(s.params ?? []))));
    } catch (e) {
      return fail(ctx, "statement_failed", request_id, sqliteCode(e));
    }
    if (results.some((r) => r.results.length > ROW_CAP)) return fail(ctx, "payload_too_large", request_id);
    const body: Json = { request_id, outpost_version: OUTPOST_VERSION, results: results.map((r) => ({ rows: r.results })), session_bookmark: session.getBookmark() };
    return finish(ctx, 200, body, { statement_hash: await sha256Hex(templates) });
  }

  const key = p.idempotency_key as string;
  const requestHash = await sha256Hex(ctx.body);
  const outcome = await runStateChange(ctx, key, requestHash, typed.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))));
  if (outcome.kind === "error") return fail(ctx, outcome.code, request_id, outcome.sqlite_code);
  if (outcome.kind === "replayed") {
    const body = outcome.body ? (JSON.parse(outcome.body) as Json) : { request_id, outpost_version: OUTPOST_VERSION, results: null, response_lost: true };
    return finish(ctx, outcome.status, { ...body, duplicate: true }, { sql_template: templates, duplicate: true });
  }
  const body: Json = {
    request_id, outpost_version: OUTPOST_VERSION,
    results: outcome.results.map((r) => ({ rows: r.results, changes: r.meta.changes, last_row_id: r.meta.last_row_id })),
  };
  await recordResponse(ctx, key, 200, body);
  return finish(ctx, 200, body, { sql_template: templates });
}

export { NONCE_TTL_SECONDS };
