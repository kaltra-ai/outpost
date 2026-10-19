// Dev client: sends a request signed with the TEST engine key to a local or remote outpost.
// Usage: node scripts/call.mjs <path> [--base http://localhost:8787] [--method POST] [--body '<json>'] [--raw] [--header "Name: value"]... [--unsigned]
// Example: node scripts/call.mjs /v1/meta
import { readFileSync } from "node:fs";
import { signRequest } from "../src/signature.ts";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--")) ?? "/v1/meta";
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const base = opt("base", process.env.OUTPOST_URL ?? "http://localhost:8787");
const method = opt("method", "GET");
const body = opt("body", undefined);
const unsigned = args.includes("--unsigned");
const raw = args.includes("--raw");
const extraHeaders = {};
args.forEach((a, i) => { if (a === "--header") { const [n, ...v] = args[i + 1].split(":"); extraHeaders[n.trim()] = v.join(":").trim(); } });

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/engine-test-key.json", import.meta.url), "utf8"));
const priv = await crypto.subtle.importKey("pkcs8", Uint8Array.from(Buffer.from(fixture.private_key_pkcs8_b64url, "base64url")), { name: "Ed25519" }, false, ["sign"]);

let req = new Request(base + path, { method, headers: { ...(body && !raw ? { "content-type": "application/json" } : {}), ...extraHeaders }, body });
if (!unsigned) req = await signRequest(req, { keyId: fixture.key_id, privateKey: priv, protocol: "1.1" });

const res = await fetch(req);
const text = await res.text();
console.log(`${res.status} ${res.statusText}`);
for (const h of ["kaltra-upstream-status", "kaltra-usage", "kaltra-request-id"]) if (res.headers.get(h)) console.log(`${h}: ${res.headers.get(h)}`);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
