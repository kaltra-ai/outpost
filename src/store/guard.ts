// Statement guard for the store gateway (docs/protocol-v1.md sections 4.4 and 4.5).
// A guardrail against mistakes and a namespace boundary, enforced by the outpost because D1 has no read-only mode.

export type StatementKind = "read" | "write" | "ddl";

export interface GuardResult {
  ok: true;
  kind: StatementKind;
  tables: string[];
}
export interface GuardFailure {
  ok: false;
  reason: string;
}

const READ_VERBS = new Set(["SELECT", "WITH"]);
const WRITE_VERBS = new Set(["INSERT", "UPDATE", "DELETE"]);
const DDL_VERBS = new Set(["CREATE", "ALTER", "DROP"]);
const FORBIDDEN_WORDS = /\b(PRAGMA|ATTACH|DETACH|VACUUM|TRIGGER|VIEW|VIRTUAL|REINDEX)\b/i;
// A read-mode statement (SELECT, WITH) may not carry a write or DDL verb anywhere: a CTE can hide a DELETE (review 2026-09-23, finding 2).
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|UPSERT)\b/i;
const IDENT = String.raw`("[^"]+"|\[[^\]]+\]|` + "`[^`]+`" + String.raw`|[A-Za-z_][A-Za-z0-9_]*)`;
// Identifiers that follow a table-position keyword. Good enough for the SQL the engine emits; anything odd is rejected.
// `DO UPDATE SET` (upsert) is not a table position; `(?<!DO\s)` keeps the guard from reading SET as a table name.
const TABLE_POSITIONS = new RegExp(String.raw`\b(?:FROM|JOIN|INTO|(?<!DO\s)UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|INDEX(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+${IDENT}\s+ON)\s+${IDENT}`, "gi");

function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function unquote(id: string): string {
  return id.replace(/^["\[`]|["\]`]$/g, "");
}

export function guardStatement(sql: string, allowed: StatementKind[]): GuardResult | GuardFailure {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "empty_statement" };
  const bare = stripStrings(trimmed);
  if (bare.includes(";")) return { ok: false, reason: "multiple_statements" };
  if (FORBIDDEN_WORDS.test(bare)) return { ok: false, reason: "forbidden_keyword" };

  const verb = (bare.match(/^\s*([A-Za-z]+)/)?.[1] ?? "").toUpperCase();
  const kind: StatementKind | null = READ_VERBS.has(verb) ? "read" : WRITE_VERBS.has(verb) ? "write" : DDL_VERBS.has(verb) ? "ddl" : null;
  if (kind === null) return { ok: false, reason: "unknown_verb" };
  if (!allowed.includes(kind)) return { ok: false, reason: `${kind}_not_allowed_here` };
  if (kind === "read" && WRITE_WORDS.test(bare)) return { ok: false, reason: "write_in_read" };

  // Any identifier anywhere that names an outpost-owned or sqlite-internal table is refused outright.
  const allIdents = bare.match(new RegExp(IDENT, "g")) ?? [];
  for (const raw of allIdents) {
    const id = unquote(raw).toLowerCase();
    if (id.startsWith("o_") || id.startsWith("sqlite_") || id.startsWith("pragma_")) return { ok: false, reason: "outside_engine_namespace" };
  }

  const tables: string[] = [];
  for (const m of bare.matchAll(TABLE_POSITIONS)) {
    const id = unquote(m[2] ?? m[1]).toLowerCase();
    if (!id.startsWith("k_")) return { ok: false, reason: "outside_engine_namespace" };
    tables.push(id);
  }
  if (tables.length === 0 && kind !== "read") return { ok: false, reason: "no_table" };
  return { ok: true, kind, tables };
}
