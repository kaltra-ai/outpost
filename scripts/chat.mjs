// Dev chat through the dev door: post a message as a member, wait for the engine's reply, print it.
// Usage: node scripts/chat.mjs "message" [--thread t1] [--as UDEV] [--name Dev] [--groups a,b] [--base http://localhost:8787] [--instance qa] [--timeout 90]
//        node scripts/chat.mjs --read --thread notify:UDEV   (print every stored reply in a thread and exit, no message posted)
// A notification the engine sends through /v1/door/dev/<instance>/notify lands in the thread `notify:<subject_id>`: read it with
// --read, then answer it with a normal message and `--thread notify:<subject_id>` to continue that conversation.
// Reads KALTRA_CRED_DEV_DOOR_SECRET from .dev.vars.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith("--")) ?? "";
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const base = opt("base", process.env.OUTPOST_URL ?? "http://localhost:8787");
const instance = opt("instance", "qa");
const thread = opt("thread", "dev-default");
const subject = opt("as", "UDEV");
const name = opt("name", "Dev");
const groups = opt("groups", "").split(",").filter(Boolean);
const timeoutS = Number(opt("timeout", "90"));
const readOnly = args.includes("--read");
if (!text && !readOnly) { console.error("usage: node scripts/chat.mjs \"message\" [--thread t] [--as U] [--groups a,b] | node scripts/chat.mjs --read --thread t"); process.exit(2); }

const devVars = Object.fromEntries(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const secret = devVars.KALTRA_CRED_DEV_DOOR_SECRET;
if (!secret) { console.error("KALTRA_CRED_DEV_DOOR_SECRET missing from .dev.vars"); process.exit(2); }

async function signed(path, body) {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`));
  const sig = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-kaltra-dev-timestamp": String(ts), "x-kaltra-dev-signature": sig }, body });
}

const before = await (await signed(`/door/dev/${instance}/replies`, JSON.stringify({ thread_id: thread, after: 0 }))).json();
if (readOnly) { for (const r of before.replies ?? []) console.log(`[kaltra in ${thread} #${r.seq}] ${r.text}`); process.exit(0); }
const lastSeq = before.replies?.length ? before.replies[before.replies.length - 1].seq : 0;
const posted = await signed(`/door/dev/${instance}`, JSON.stringify({ subject_id: subject, display_name: name, text, thread_id: thread, groups }));
if (posted.status !== 202) { console.error("post failed", posted.status, await posted.text()); process.exit(1); }
console.log(`[${subject} in ${thread}] ${text}`);
const deadline = Date.now() + timeoutS * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const res = await (await signed(`/door/dev/${instance}/replies`, JSON.stringify({ thread_id: thread, after: lastSeq }))).json();
  if (res.replies?.length) { for (const r of res.replies) console.log(`[kaltra] ${r.text}`); process.exit(0); }
}
console.error("no reply within the timeout"); process.exit(1);
