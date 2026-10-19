import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import worker from "../src/index";
import { ensureOutpostSchema, OUTPOST_SCHEMA_VERSION } from "../src/store/schema";

describe("outpost-owned schema", () => {
  it("upgrades an older outpost schema in place on first use and records its version", async () => {
    // Simulate a database left behind by outpost schema v1: o_threads without platform_key, no o_meta.
    await env.STORE.batch([
      env.STORE.prepare("DROP TABLE IF EXISTS o_threads"),
      env.STORE.prepare("DROP TABLE IF EXISTS o_meta"),
      env.STORE.prepare("CREATE TABLE o_threads (thread_id TEXT PRIMARY KEY, door_kind TEXT NOT NULL, instance TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    ]);
    await ensureOutpostSchema(env.STORE, { force: true });

    const cols = await env.STORE.prepare("SELECT name FROM pragma_table_info('o_threads')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("platform_key");
    const meta = await env.STORE.prepare("SELECT outpost_schema_version FROM o_meta WHERE id = 1").first<{ outpost_schema_version: number }>();
    expect(meta?.outpost_schema_version).toBe(OUTPOST_SCHEMA_VERSION);
  });
});

describe("unhandled failures", () => {
  it("never leaks an HTML error page: an unexpected exception becomes a structured internal error", async () => {
    const broken = { ...env, KALTRA_ENGINE_PUBLIC_KEYS: "this is not json" } as unknown as typeof env;
    const res = await worker.fetch(new Request("https://outpost.test.invalid/v1/meta"), broken);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal");
    void SELF;
  });
});
