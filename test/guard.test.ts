import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { guardStatement } from "../src/store/guard";

const FTS = "CREATE VIRTUAL TABLE k_index_fts USING fts5(chunk_id UNINDEXED, title, heading, text, summary, keywords, tokenize = 'unicode61 remove_diacritics 2')";

describe("guard: FTS5 allowance", () => {
  it("accepts an fts5 virtual table in the engine namespace as ddl", () => {
    const r = guardStatement(FTS, ["ddl"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tables).toEqual(["k_index_fts"]);
  });
  it("still refuses virtual tables outside fts5, outside k_, and in read or write mode", () => {
    expect(guardStatement("CREATE VIRTUAL TABLE k_x USING rtree(id, a, b)", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
    expect(guardStatement("CREATE VIRTUAL TABLE o_x USING fts5(a)", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
    expect(guardStatement(FTS, ["read", "write"])).toMatchObject({ ok: false, reason: "ddl_not_allowed_here" });
    expect(guardStatement("CREATE TRIGGER k_t AFTER INSERT ON k_index BEGIN SELECT 1; END", ["ddl"])).toMatchObject({ ok: false });
  });
  it("accepts the match query and the per-row delete the engine will send", () => {
    expect(guardStatement("SELECT k_index.chunk_id, bm25(k_index_fts, 0.0, 3.0, 2.0, 1.0, 2.0, 2.0) AS score FROM k_index_fts JOIN k_index ON k_index.chunk_id = k_index_fts.chunk_id WHERE k_index_fts MATCH ?1 AND k_index.instance = ?2 AND k_index.retired_at IS NULL ORDER BY score LIMIT ?3", ["read"]).ok).toBe(true);
    expect(guardStatement("DELETE FROM k_index_fts WHERE chunk_id IN (SELECT chunk_id FROM k_index WHERE instance = ?1 AND doc_ref = ?2)", ["read", "write"]).ok).toBe(true);
  });
  it("pins the edges: IF NOT EXISTS and mixed case accepted; a bare k_, a trailing statement, an external-content option, and a TRIGGER token inside the arguments refused", () => {
    expect(guardStatement("CREATE VIRTUAL TABLE IF NOT EXISTS k_idx_fts USING Fts5(text)", ["ddl"]).ok).toBe(true);
    expect(guardStatement("CREATE VIRTUAL TABLE k_ USING fts5(text)", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
    expect(guardStatement("CREATE VIRTUAL TABLE k_x USING fts5(text); DROP TABLE o_audit", ["ddl"])).toMatchObject({ ok: false, reason: "multiple_statements" });
    expect(guardStatement("CREATE VIRTUAL TABLE k_x USING fts5(a, content='o_audit')", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
    expect(guardStatement("CREATE VIRTUAL TABLE k_x USING fts5(a, content_rowid = 'id')", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
    expect(guardStatement("CREATE VIRTUAL TABLE k_x USING fts5(a, trigger)", ["ddl"])).toMatchObject({ ok: false, reason: "forbidden_keyword" });
  });
  it("D1 in this runtime supports fts5 (the spike every later task stands on)", async () => {
    try {
      await env.STORE.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS k_spike_fts USING fts5(chunk_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')").run();
      await env.STORE.prepare("INSERT INTO k_spike_fts (chunk_id, text) VALUES ('c1', 'Chaque nouveau client passe par la même séquence: appel de lancement, entente signée.')").run();
      const r = await env.STORE.prepare("SELECT chunk_id, bm25(k_spike_fts) AS score FROM k_spike_fts WHERE k_spike_fts MATCH ?1").bind('"entente"* OR "lancement"*').all<{ chunk_id: string; score: number }>();
      expect(r.results.map((x) => x.chunk_id)).toEqual(["c1"]);
      expect(r.results[0].score).toBeLessThan(0);
    } finally {
      await env.STORE.prepare("DROP TABLE IF EXISTS k_spike_fts").run();
    }
  });
});
