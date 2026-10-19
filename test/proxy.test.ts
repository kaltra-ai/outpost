import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { callRaw } from "./helpers";

type Captured = { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string };

function stubUpstream(respond: (c: Captured) => Response | Promise<Response>) {
  const captured: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const c: Captured = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text(), redirect: init?.redirect ?? req.redirect };
    captured.push(c);
    return respond(c);
  });
  return captured;
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /v1/llm/<credential>", () => {
  it("forwards the raw body to the allowed host with the credential injected and returns the raw response plus usage", async () => {
    const captured = stubUpstream(() => Response.json({ id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 12, output_tokens: 7 }, content: [{ type: "text", text: "hi" }] }));
    const body = JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    const res = await callRaw("/v1/llm/anthropic-main", {
      body,
      headers: { "Kaltra-Upstream-Method": "POST", "Kaltra-Upstream-Path": "/v1/messages", "Kaltra-Upstream-Header-content-type": "application/json", "Kaltra-Upstream-Header-anthropic-version": "2023-06-01" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Kaltra-Upstream-Status")).toBe("200");
    expect(JSON.parse(res.headers.get("Kaltra-Usage")!)).toEqual({ input_tokens: 12, output_tokens: 7, model: "claude-sonnet-5" });
    expect((await res.json()) as unknown).toMatchObject({ id: "msg_1" });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0].method).toBe("POST");
    expect(captured[0].body).toBe(body);
    expect(captured[0].headers["x-api-key"]).toBe("test-anthropic-key");
    expect(captured[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[0].headers["kaltra-signature"]).toBeUndefined();
    expect(captured[0].redirect).toBe("manual");
  });

  it("refuses an unknown credential, a disallowed method, a disallowed header, and a path escape", async () => {
    stubUpstream(() => Response.json({}));
    const base = { body: "{}", headers: { "Kaltra-Upstream-Method": "POST", "Kaltra-Upstream-Path": "/v1/messages" } };
    const unknown = await callRaw("/v1/llm/nope", base);
    const method = await callRaw("/v1/llm/anthropic-main", { ...base, headers: { ...base.headers, "Kaltra-Upstream-Method": "DELETE" } });
    const header = await callRaw("/v1/llm/anthropic-main", { ...base, headers: { ...base.headers, "Kaltra-Upstream-Header-authorization": "Bearer x" } });
    const escape = await callRaw("/v1/llm/anthropic-main", { ...base, headers: { ...base.headers, "Kaltra-Upstream-Path": "/../v1/messages" } });
    expect([unknown.status, (await unknown.json() as { error: { code: string } }).error.code]).toEqual([404, "credential_not_found"]);
    expect(((await method.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
    expect(((await header.json()) as { error: { code: string } }).error.code).toBe("header_not_allowed");
    expect(((await escape.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("maps an upstream 429 to upstream_rate_limited with retry_after_ms, and a network failure to upstream_error", async () => {
    stubUpstream(() => new Response("slow down", { status: 429, headers: { "retry-after": "7" } }));
    const limited = await callRaw("/v1/llm/anthropic-main", { body: "{}", headers: { "Kaltra-Upstream-Method": "POST", "Kaltra-Upstream-Path": "/v1/messages" } });
    expect(limited.status).toBe(429);
    expect((await limited.json()) as unknown).toMatchObject({ error: { code: "upstream_rate_limited", retryable: true, retry_after_ms: 7000 } });

    vi.stubGlobal("fetch", async () => { throw new TypeError("connection reset"); });
    const failed = await callRaw("/v1/llm/anthropic-main", { body: "{}", headers: { "Kaltra-Upstream-Method": "POST", "Kaltra-Upstream-Path": "/v1/messages" } });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("upstream_error");
  });
});

describe("POST /v1/source/<instance>", () => {
  it("mints an OAuth2 client-credentials token once, caches it, and calls the source with a bearer", async () => {
    await env.TOKEN_CACHE.delete("token:graph-main:https://graph.microsoft.com/.default");
    const captured = stubUpstream((c) =>
      c.url.startsWith("https://login.microsoftonline.com/")
        ? Response.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 })
        : Response.json({ value: [{ name: "Policies.pdf" }] }),
    );
    const headers = { "Kaltra-Upstream-Method": "GET", "Kaltra-Upstream-Path": "/v1.0/sites/contoso.sharepoint.com,site-id/drive/root/children", "Kaltra-Upstream-Header-accept": "application/json" };
    const first = await callRaw("/v1/source/inst-sp", { headers });
    const second = await callRaw("/v1/source/inst-sp", { headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()) as unknown).toEqual({ value: [{ name: "Policies.pdf" }] });

    const tokenCalls = captured.filter((c) => c.url.startsWith("https://login.microsoftonline.com/"));
    const graphCalls = captured.filter((c) => c.url.startsWith("https://graph.microsoft.com/"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toContain("grant_type=client_credentials");
    expect(tokenCalls[0].body).toContain("client_secret=test-graph-client-secret");
    expect(tokenCalls[0].body).toContain(encodeURIComponent("https://graph.microsoft.com/.default"));
    expect(graphCalls).toHaveLength(2);
    expect(graphCalls[0].headers["authorization"]).toBe("Bearer tok-1");
    expect(graphCalls[0].url).toBe("https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com,site-id/drive/root/children");
  });

  it("refuses an unknown instance", async () => {
    stubUpstream(() => Response.json({}));
    const res = await callRaw("/v1/source/nope", { headers: { "Kaltra-Upstream-Method": "GET", "Kaltra-Upstream-Path": "/x" } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("instance_not_found");
  });
});

describe("POST /v1/source/<instance> with a credential of type none (outpost 0.2.0)", () => {
  it("calls the allowed host with nothing injected and no secret configured", async () => {
    const captured = stubUpstream(() => new Response("# Onboarding\n\n## Checklist\n\n- Kickoff call", { status: 200, headers: { "content-type": "text/markdown" } }));
    const res = await callRaw("/v1/source/docs-main", { headers: { "Kaltra-Upstream-Method": "GET", "Kaltra-Upstream-Path": "/services/onboarding.md", "Kaltra-Upstream-Header-accept": "text/markdown" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Kaltra-Upstream-Status")).toBe("200");
    expect(await res.text()).toContain("## Checklist");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://docs.test.invalid/services/onboarding.md");
    expect(captured[0].method).toBe("GET");
    expect(captured[0].headers["accept"]).toBe("text/markdown");
    expect(captured[0].headers["authorization"]).toBeUndefined();
    expect(captured[0].headers["x-api-key"]).toBeUndefined();
    expect(captured[0].headers["kaltra-signature"]).toBeUndefined();
    expect(captured[0].redirect).toBe("manual");
  });

  it("still enforces the allow-lists: POST refused, authorization never forwarded even if asked for", async () => {
    stubUpstream(() => new Response("nope"));
    const method = await callRaw("/v1/source/docs-main", { headers: { "Kaltra-Upstream-Method": "POST", "Kaltra-Upstream-Path": "/index.json" } });
    const auth = await callRaw("/v1/source/docs-main", { headers: { "Kaltra-Upstream-Method": "GET", "Kaltra-Upstream-Path": "/index.json", "Kaltra-Upstream-Header-authorization": "Bearer leak" } });
    expect(((await method.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
    expect(((await auth.json()) as { error: { code: string } }).error.code).toBe("header_not_allowed");
  });

  it("advertises none in /v1/meta credential_types with the bumped outpost version", async () => {
    const { call } = await import("./helpers");
    const meta = await call("/v1/meta");
    expect(meta.status).toBe(200);
    expect(meta.json.credential_types).toContain("none");
    expect(meta.json.outpost_version).toBe("1.1.0");
    expect((meta.json.instances as { id: string }[]).map((i) => i.id)).toEqual(expect.arrayContaining(["docs-main", "docs-directors"]));
  });
});
