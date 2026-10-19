# kaltra-outpost

The tenant-side component of [Kaltra AI](https://kaltra.ai). One small Cloudflare Worker that a company deploys in its own Cloudflare account. It holds the company's secrets, fronts the company's database, makes every outbound call (to the LLM provider, to the document sources) from the company's account with the company's credentials, and receives messages from the company's chat platform. It signs and forwards. It never decides anything.

The Kaltra Engine (the part that thinks) runs elsewhere and reaches this Worker only through signed requests the company can revoke by deleting one key from this Worker's configuration. No content of the company's (messages, memory, documents, prompts, replies) is stored outside the company's account.

This repository is open source so that the people who run it can read every line of the thing that holds their secrets. Security reports: see [SECURITY.md](SECURITY.md).

## What it does

- Receives events from your chat platform through a door module, verifies them, acknowledges, queues them in your account, and forwards them to the engine.
- Sends replies back to your chat platform with your bot credentials.
- Proxies calls to your LLM provider and to your document sources using credentials that never leave this Worker, restricted to the hosts and methods each credential is allowed to reach.
- Fronts your D1 database: query, migrate, export, wipe.

## What it never does

- Hold prompts, interpret results, or make decisions.
- Send anything to anyone other than the hosts you allow-listed and the engine you paired it with.
- Store a long-lived secret anywhere but Worker secrets in your account. Short-lived access tokens it mints for you are cached in a KV namespace in your account, with their expiry, and are never exported.

## Contract

The protocol between the engine and this Worker is specified in [docs/protocol-v1.md](docs/protocol-v1.md). That document is the contract; the code implements it.

## What it implements

Implemented and tested: request signing and verification (RFC 9421, Ed25519, `src/signature.ts`, vector in `docs/signature-vectors.md`); engine authentication on `/v1/*`; fixed-string error responses; `GET /v1/meta`; the store gateway (`/v1/store/query` in read and write mode with the `k_*`/`o_*` namespace boundary, `/v1/store/migrate` with the schema guard), replay rejection through the nonce table, idempotency with stored responses, an audit row per call, and the hourly cleanup. The LLM and source proxies (`/v1/llm/<credential>`, `/v1/source/<instance>`): raw-body transport, credential allow-lists for host, method, and headers, static-header and OAuth2 client-credentials injection with a KV token cache, credential type `none` for public hosts (nothing injected, allow-lists still enforced), no redirects followed, rate-limit and failure mapping, usage parsing, audit. The Slack door: inbound verification, drop rules, dedup and claim-check, the activity indicator (reaction while the engine works, assistant status in DMs; scopes `reactions:write` and the Agents & AI Apps feature), the queue consumer that carries each envelope to the engine synchronously with the retry schedule and the unavailable line, `/send` through the thread map, and `/notify` (the engine opens a DM with one member and the DM becomes a known thread, for the weekly digest; scope `im:write`). Not in this release: export, wipe, and the Teams door; they answer `unknown_route`.

Development: `npm install` (generates `worker-configuration.d.ts`), `npm test`, `npm run typecheck`.

Local play: `npm run dev` starts an outpost on port 8787 from `wrangler.dev.jsonc` (the test config plus the queue consumer) (local D1, KV, queues, the test engine key). In another terminal, `npm run call -- <path> [--method POST --body '<json>'] [--unsigned]` sends a request signed with the test key. For example:

```
npm run call -- /v1/meta
npm run call -- /v1/store/migrate --method POST --body '{"request_id":"r1","idempotency_key":"m1","expected_schema_version":null,"target_schema_version":1,"statements":["CREATE TABLE IF NOT EXISTS k_items_shared (id TEXT PRIMARY KEY, text TEXT NOT NULL)"]}'
npm run call -- /v1/store/query --method POST --body '{"request_id":"r2","idempotency_key":"w1","mode":"write","statements":[{"sql":"INSERT INTO k_items_shared (id,text) VALUES (?1,?2)","params":["i1","hello"]}]}'
npm run call -- /v1/store/query --method POST --body '{"request_id":"r3","mode":"read","statements":[{"sql":"SELECT * FROM k_items_shared"}]}'
```

### Doors are modules

A door turns one chat platform's events into envelopes and posts the engine's replies back. The outpost ships with the dev door (`src/doors/dev.ts`, the reference implementation of `src/doors/sdk.ts`); platform doors are separate packages registered by a tenant entry point:

```ts
// src/entry.<tenant>.ts (git-ignored), set as "main" in that tenant's wrangler config
import { registerDoor } from "./doors/registry";
import { door as teams } from "@kaltra-ai/door-teams"; // a platform door, its own package
import worker from "./index";
registerDoor(teams);
export default worker;
```

A door module implements `DoorModule` from `kaltra-outpost/doors/sdk`: `inbound` (verify the platform signature, build the envelope, enqueue), `send`, `notify`, optional `afterSend` and extra `routes`. The SDK gives it `findDoor`, `verifyV0Signature`, `lookupThread`, `threadIdFor`, `credentialSecret`, `ensureOutpostSchema`, and `errorResponse`. Each tenant's `KALTRA_CONFIG` lists its doors by kind and instance; a kind with no registered module answers `unknown_route`.


## Requirements (tenant side)

- A Cloudflare account (Workers Paid recommended) with Zero Trust enabled.
- A zone in that account and a hostname on it, used as a Workers Custom Domain.
- A Cloudflare Access application on `/v1/*` of that hostname: a Service Auth policy for the engine, an Allow policy for your admins (export and wipe).
- Platform registrations for each door you enable (see the protocol document, section 10).

## Licence

Apache License 2.0. See [LICENSE](LICENSE).

## Deploying for a tenant

1. Copy `wrangler.jsonc` to `wrangler.<tenant>.jsonc` (git-ignored) and fill in the name, custom domain, D1 id, KV id, engine URL, region hint, the outpost key id and engine public keys from the operator's key generation, and `KALTRA_CONFIG`.
2. Create the resources once: `wrangler d1 create <name> --location <hint>`, `wrangler kv namespace create <name>`, `wrangler queues create kaltra-inbound` and `kaltra-inbound-dlq`.
3. Set the secrets with `wrangler secret put <NAME> --config wrangler.<tenant>.jsonc`: `KALTRA_OUTPOST_PRIVATE_KEY` and one `KALTRA_CRED_<NAME>` per credential in the config (except type `none`).
4. `wrangler deploy --config wrangler.<tenant>.jsonc`. The custom domain and its DNS record are created on first deploy.
5. Put a Cloudflare Access application with a Service Auth policy on `<hostname>/v1/*` and give the service token to the operator. Door routes (`/door/*`) stay outside Access.
6. The operator applies the memory schema through `/v1/store/migrate` and points the tenant record at the hostname.
