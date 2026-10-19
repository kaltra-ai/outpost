import { OUTPOST_VERSION } from "../config";

export interface AuditRow {
  request_id: string;
  route: string;
  actor: "engine" | "tenant" | "platform";
  key_id?: string | null;
  protocol_version?: string | null;
  engine_version?: string | null;
  credential_name?: string | null;
  instance_id?: string | null;
  host?: string | null;
  statement_hash?: string | null;
  sql_template?: string | null;
  member_subject_id?: string | null;
  bytes_in?: number | null;
  bytes_out?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  model?: string | null;
  duration_ms: number;
  status: number;
  error_code?: string | null;
  duplicate?: boolean;
  cf_ray?: string | null;
}

export function auditStatement(db: D1Database, row: AuditRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO o_audit (request_id, ts, route, actor, key_id, protocol_version, engine_version, outpost_version, credential_name, instance_id, host, statement_hash, sql_template, member_subject_id, bytes_in, bytes_out, tokens_in, tokens_out, model, duration_ms, status, error_code, duplicate, cf_ray)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`,
    )
    .bind(
      row.request_id, Math.floor(Date.now() / 1000), row.route, row.actor, row.key_id ?? null, row.protocol_version ?? null, row.engine_version ?? null, OUTPOST_VERSION,
      row.credential_name ?? null, row.instance_id ?? null, row.host ?? null, row.statement_hash ?? null, row.sql_template ?? null, row.member_subject_id ?? null,
      row.bytes_in ?? null, row.bytes_out ?? null, row.tokens_in ?? null, row.tokens_out ?? null, row.model ?? null, row.duration_ms, row.status, row.error_code ?? null,
      row.duplicate ? 1 : 0, row.cf_ray ?? null,
    );
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
