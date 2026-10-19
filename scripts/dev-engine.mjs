// Dev-only "echo engine": the smallest thing that can sit at the other end of /v1/inbound so tenant zero has a round trip.
// It verifies the outpost's signature with the TEST outpost key, then replies through the outpost's /send route,
// signed with the TEST engine key. Never deploy this. Usage: node scripts/dev-engine.mjs [--port 8788] [--outpost http://localhost:8787]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { signRequest, verifyRequest } from "../src/signature.ts";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const port = Number(opt("port", "8788"));
const outpost = opt("outpost", "http://localhost:8787");
const PROTOCOL = "1.1";

const engineKey = JSON.parse(readFileSync(new URL("../test/fixtures/engine-test-key.json", import.meta.url), "utf8"));
const outpostKey = JSON.parse(readFileSync(new URL("../test/fixtures/outpost-test-key.json", import.meta.url), "utf8"));
const b64u = (s) => Uint8Array.from(Buffer.from(s, "base64url"));
const enginePriv = await crypto.subtle.importKey("pkcs8", b64u(engineKey.private_key_pkcs8_b64url), { name: "Ed25519" }, false, ["sign"]);
const outpostPub = await crypto.subtle.importKey("raw", b64u(outpostKey.public_key_raw_b64url), { name: "Ed25519" }, false, ["verify"]);
const keys = new Map([[outpostKey.key_id, outpostPub]]);

async function send(threadId, text) {
  const body = JSON.stringify({ request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), thread_id: threadId, text, format: "markdown", actions: [] });
  const req = await signRequest(new Request(`${outpost}/v1/door/dev/qa/send`, { method: "POST", headers: { "content-type": "application/json" }, body }), { keyId: engineKey.key_id, privateKey: enginePriv, protocol: PROTOCOL });
  const res = await fetch(req);
  console.log(`  -> /send ${res.status} ${await res.text()}`);
}

createServer(async (nodeReq, nodeRes) => {
  const chunks = [];
  for await (const c of nodeReq) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);
  const url = `http://localhost:${port}${nodeReq.url}`;
  const req = new Request(url, { method: nodeReq.method, headers: nodeReq.headers, body: bodyBuf.length ? bodyBuf : undefined });
  const body = bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength);

  if (nodeReq.url !== "/v1/inbound" && nodeReq.url !== "/v1/events") { nodeRes.writeHead(404); nodeRes.end(); return; }
  const verified = await verifyRequest(req, body, { keys, expectedProtocol: PROTOCOL });
  if (!verified.ok) { console.log(`refused: ${verified.reason}`); nodeRes.writeHead(401); nodeRes.end(); return; }

  const payload = JSON.parse(bodyBuf.toString("utf8"));
  if (nodeReq.url === "/v1/events") { console.log("event", payload); nodeRes.writeHead(200); nodeRes.end("{}"); return; }

  console.log(`inbound ${payload.event_id} from ${payload.member?.subject_id} in ${payload.scope}: ${JSON.stringify(payload.text)}`);
  try {
    await send(payload.thread_id, `You said: *${payload.text}*. (echo engine, no memory yet)`);
    nodeRes.writeHead(200, { "content-type": "application/json" }); nodeRes.end(JSON.stringify({ request_id: crypto.randomUUID() }));
  } catch (e) {
    console.log("send failed", e); nodeRes.writeHead(503); nodeRes.end();
  }
}).listen(port, () => console.log(`echo engine on http://localhost:${port}, replying through ${outpost}`));
