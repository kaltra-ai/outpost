# Outpost protocol v1 (spec sheet)

The contract between the Kaltra engine (hosted by the operator, closed) and a tenant's outpost (this repository, open source, deployed in the tenant's own Cloudflare account). This is the one interface that is expensive to change once tenants run it, so it is written before any code.

Status: v1.1, 2026-09-22, forks confirmed; implementation starting with signature verification and `/v1/meta`. Revised after three independent reviews (security and protocol, Cloudflare platform feasibility, Slack/Teams/Graph integration). Not yet implemented. Platform facts cited in the review records.

## 1. Scope and non-goals

The outpost does four things and nothing else: receive door events and hand them to the engine; send replies to doors; make outbound calls with the tenant's credentials; front the tenant's store. It holds no prompts, no manifests, no interpretation, no decisions.

Non-goals for v1: streaming responses (neither Slack nor Teams posts partial replies); interactive door callbacks (route reserved, inbound invokes acknowledged, nothing acted on); tenant self-service secret entry (the API path exists, the page does not); outpost auto-update; Teams channel and group-chat file attachments (need a Graph files permission not in the v1 install); Teams private channels (bots cannot post there).

## 2. Trust model

- **Two keypairs per tenant.** The engine holds a signing keypair per tenant; the outpost holds its own. Public keys are exchanged at install through the operator dashboard. Each side may hold up to two active public keys per peer, with distinct key ids, so rotation is add-new, switch sender, remove-old, with no outage. `/v1/meta` lists the engine key ids the outpost currently accepts.
- **Every engine-to-outpost and outpost-to-engine request is signed** with RFC 9421 HTTP Message Signatures, algorithm `ed25519`, covered components `@method`, `@authority`, `@path`, `@query`, `content-digest`, `kaltra-protocol`, `kaltra-key-id`, `kaltra-timestamp`, `kaltra-nonce`. `Content-Digest` is `sha-256` over the raw body bytes. `Kaltra-Timestamp` is Unix seconds; receivers reject a skew above 300 seconds in either direction. `Kaltra-Nonce` is at least 128 bits of randomness, base64url. The exact signature base and a worked test vector live in `docs/signature-vectors.md` (to be written with the first implementation; both sides must pass it in CI).
- **Digest is verified after buffering, before acting on the body.** A Worker cannot verify a digest without reading the body; the guarantee is that nothing is executed or forwarded until the digest and signature pass.
- **Replay protection.** Nonces are recorded for every request that changes state or sends anything (store write mode, migrate, door send, wipe, engine events); the record is an `INSERT` into the outpost's `o_nonces` table with a unique constraint, in the same D1 batch as the request's own statements, purged after 15 minutes by the cron. Read-only requests (store read mode, meta, llm, source, fetch) rely on TLS, Access, and the 300-second timestamp window; they carry a nonce that is not stored. See section 12, fork 1, for the alternative.
- **Tenant identity comes from the key id, never from the payload.** The engine maps `Kaltra-Key-Id` to a tenant; a body field naming a tenant is ignored.
- **Second layer, engine routes only:** a Cloudflare Access application scoped to `<outpost-hostname>/v1/*` with a Service Auth policy; the engine presents the service token headers. Door routes (`/door/*`) are outside any Access application, because Slack and Microsoft cannot present a service token; they are protected by the platform signature checks in section 4.8 and rate-limited at the edge. The tenant's account needs Zero Trust enabled (free tier suffices).
- **Tenant-admin routes:** `/v1/store/export` and `/v1/store/wipe` are callable only by a human passing an Access Allow policy for tenant admins; the Worker validates the `Cf-Access-Jwt-Assertion` against the team's keys and the application audience. The engine cannot call them. The audit row records the actor class.
- **Off switch:** the tenant deletes the engine's public keys from the outpost config, or revokes the Access service token. Either one stops the engine completely. Nothing at the operator needs to be deleted, because no tenant content is stored there (section 11).
- **What this does not do:** protect the engine from being rebuilt. The protocol is public and carries no value. The engine's protection is that it never leaves the operator's account.

## 3. Common envelope, errors, caps

Every request carries `request_id` (UUID minted by the sender, echoed in the response and the audit row) and the sender's version (`engine_version` or `outpost_version`). Every state-changing request carries `idempotency_key` (section 9).

Every response carries `request_id`, `outpost_version`, and on error `{error: {code, message, retryable, retry_after_ms?}}`. `message` is a fixed string per code and never includes upstream body content. Codes: `invalid_request` (malformed body or missing required field), `unauthorized`, `unknown_route`, `credential_not_found`, `instance_not_found`, `host_not_allowed`, `method_not_allowed`, `header_not_allowed`, `schema_version_mismatch`, `statement_not_allowed`, `statement_failed` (an engine statement failed inside D1; the batch rolled back; `sqlite_code` carries the SQLite result code such as `SQLITE_CONSTRAINT_PRIMARYKEY`, never the message, which can name columns), `upstream_error`, `upstream_timeout`, `upstream_rate_limited` (retryable, with `retry_after_ms`), `recipient_blocked` (not retryable: the platform refused the thread, stop posting to it), `payload_too_large`, `duplicate` (idempotent replay, returns the stored response), `idempotency_conflict`, `unavailable`, `internal` (an unexpected outpost failure; retryable; never an HTML page).

Body transport differs by route family:

| Route | Body | Request cap | Response cap |
|---|---|---|---|
| `/v1/store/*`, `/v1/inbound`, `/v1/events`, `/v1/meta` | JSON | 1 MB | 1 MB (export streams, uncapped) |
| `/v1/llm/<credential>` | raw upstream body, `Kaltra-Upstream-*` headers | 32 MB | 8 MB |
| `/v1/source/<instance>` | raw upstream body, `Kaltra-Upstream-*` headers | 1 MB | 25 MB |
| `/v1/door/<kind>/<instance>/fetch` | JSON `{attachment_ref}` | 1 KB | 25 MB |
| `/v1/door/<kind>/<instance>/send` | JSON reply shape | 1 MB, plus per-platform text caps (section 5.2) | n/a |
| `/v1/door/<kind>/<instance>/notify` | JSON `{subject_id, text, format}` | 1 MB, plus per-platform text caps (section 5.2) | n/a |
| `/door/<kind>/<instance>` (platform inbound) | platform payload | 1 MB | n/a |

Raw-body routes carry `Kaltra-Upstream-Method`, `Kaltra-Upstream-Path`, `Kaltra-Upstream-Query` (URL-encoded), and `Kaltra-Upstream-Header-<name>` for each allowed header. Because their body is opaque, they carry `request_id` and the sender version as headers instead: `Kaltra-Request-Id` and `Kaltra-Engine-Version`. The response echoes `Kaltra-Request-Id` and adds `Kaltra-Upstream-Status`; the LLM route adds `Kaltra-Usage` (`input_tokens`, `output_tokens`, `model`, parsed from Anthropic-style or OpenAI-style usage fields when present). Any upstream status other than 429 is returned as-is inside a 200 from the outpost; 429 is mapped to `upstream_rate_limited`. The outpost buffers the body once, verifies the digest, and forwards the same buffer. Attachment bytes never ride inside the inbound envelope; the envelope carries a reference and the engine fetches on demand. Extraction and OCR are engine-side.

D1 limits the store routes inherit and return as `payload_too_large`: 100 bound parameters per statement, 100 KB per statement, 1,000 statements per request, 2 MB per row.

## 4. Routes, one per kind

All routes are under the outpost hostname the tenant chose, which must be a Workers Custom Domain (never a route pattern; same-zone Worker-to-Worker fetch only works to a Custom Domain, and tenant zero has engine and outpost in one zone). Engine-initiated routes are prefixed `/v1/`.

### 4.1 `GET /v1/meta`

Returns: `protocol` (major.minor), `outpost_version`, `schema_version` (applied engine schema), `engine_key_ids` (accepted), `door_kinds` (kind, adapter version), `credential_types`, `instances` (id, module, kind, scope, audience, credential name; read-only view of the deployed config), `region_hint` (the D1 location hint the operator recorded at creation; the binding does not expose it), `queues` (`inbound` and `dlq` backlog from the queue metrics API), `limits`. The dashboard health check calls this.

### 4.2 `POST /v1/llm/<credential-name>`

Request-response proxy to an LLM provider using the named credential. The outpost builds the upstream URL itself from the credential's host and the `Kaltra-Upstream-Path` and `-Query` headers (section 6 rules), injects the credential, forwards without following redirects, and returns the provider's raw response body with `Kaltra-Upstream-Status` and `Kaltra-Usage` (`input_tokens`, `output_tokens`, `model` parsed per provider when present). Timeout: 120 seconds (outpost-owned `AbortSignal`). Tool-use loops are N calls. No streaming: the outpost buffers and returns.

### 4.3 `POST /v1/source/<instance-id>`

Outbound call for one source module instance. The outpost resolves the instance to its credential and the scope the instance declares (section 6), builds the URL, injects the credential (minting and caching an OAuth2 token when the type requires it), forwards without following redirects, and returns the raw response with `Kaltra-Upstream-Status`. A 429 upstream returns `upstream_rate_limited` with the provider's `Retry-After` as `retry_after_ms`. Timeout: 30 seconds, overridable per instance up to 60. The engine owns the higher-level timeout that protects the reply.

### 4.4 `POST /v1/store/query`

A batch of single parametrised SQL statements: `{statements: [{sql, params}], mode: "read" | "write", session_bookmark?}`. Each entry is exactly one statement (D1 `prepare` rejects multi-statement strings). Read mode runs in a D1 session with read replication and returns `session_bookmark` for read-your-writes. Write mode runs atomically on the primary and requires `idempotency_key`.

Table boundary, the real security rule: engine statements may name only `k_*` tables. `o_*` tables (section 7) are outpost-owned and appear in no engine statement. The outpost parses each statement's table set and rejects with `statement_not_allowed` any statement that names an `o_*` table, any statement whose first keyword is not `SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `WITH`, and any `PRAGMA`, `ATTACH`, `VACUUM`. This is enforced by the outpost; D1 has no read-only binding mode. Row cap per response: 10,000 (outpost-side).

### 4.5 `POST /v1/store/migrate`

DDL batch `{expected_schema_version, target_schema_version, statements}`, guarded by the outpost-owned `o_schema` table (refused with `schema_version_mismatch` on mismatch), applied atomically with the version bump in the same batch. Migrate may only `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, `DROP INDEX`, or `DROP TABLE` on `k_*` names, plus `INSERT`, `UPDATE`, `DELETE` on `k_*` tables for the seed rows a migration needs (a meta row, defaults). Never triggers, views, `PRAGMA`, `ATTACH`, and never an `o_*` table. The audit row stores the full DDL text. Requires `idempotency_key`.

### 4.6 `POST /v1/store/export`

Tenant-admin only (Access JWT). The outpost opens one D1 session with `first-primary`, pages every table (`k_*` and `o_*`, including audit) with `LIMIT/OFFSET` inside that session for a consistent snapshot, and streams NDJSON, one file section per table, with a header line carrying `schema_version` and `outpost_version`. This is a logical export, not a SQLite file; a tenant wanting the raw database runs `wrangler d1 export` themselves. The KV token cache is not part of the export.

### 4.7 `POST /v1/store/wipe`

Tenant-admin only (Access JWT). Body `{confirm: "<outpost hostname>"}` typed by the admin. Clears every `k_*` and `o_*` table except `o_schema`, clears the KV token cache, then sends `wiped` to the engine (section 4.9). The engine, holding no content, marks the tenant wiped in the dashboard.

### 4.8 Doors

`<kind>` is `slack` or `teams` in v1; `<instance>` distinguishes two doors of the same kind. Door adapters are a versioned table inside the outpost; a new kind bumps the outpost minor version and appears in `/v1/meta`.

- **`POST /door/<kind>/<instance>`** (inbound, called by the platform, outside Access). Steps in order: verify the platform signature on the raw bytes; drop non-message events; deduplicate; claim-check; acknowledge.
  - Slack: `v0` HMAC over `timestamp:body` with the signing secret, reject `|now - X-Slack-Request-Timestamp| > 300 s`; answer `url_verification` only after the HMAC passes. Drop any event carrying `bot_id`, a `subtype`, or a `user` equal to the installation's own user id. Always return 200 within 3 seconds; return `x-slack-no-retry: 1` on unrecoverable payloads so the subscription is never auto-disabled.
  - Teams: validate the Bearer JWT: signature against the Bot Framework OpenID key set (cached at most 24 hours), issuer `https://api.botframework.com`, audience equals the door's app id, `exp`/`nbf` with 5-minute skew, and the `serviceurl` claim equals `activity.serviceUrl`; 403 on any failure. Reject any activity whose `conversation.tenantId` differs from the door's configured tenant id. Drop `messageUpdate`, `messageDelete`, `messageReaction`, `conversationUpdate`, `installationUpdate`. Answer `invoke` activities synchronously with a 200 and a fixed "received" body, then enqueue them as an envelope with `interaction` set (nothing acts on them in v1). Strip only the bot's own mention (`mentioned.id == recipient.id`) from `text`; keep other mentions. Never surface the duplicate `text/html` attachment.
  - Dedup and claim-check: insert the canonical envelope into `o_inbound` keyed by `(door_kind, instance, event_id)`; the unique constraint is the dedup check; on conflict acknowledge and stop. Enqueue `{event_id}` only (Queue messages are capped at 128 KB).
  - Unknown kind or instance returns the same 404 body as any unmatched route.
- **`POST /v1/door/<kind>/<instance>/send`** (engine-initiated). Body: the reply shape (section 5.2). The adapter resolves `thread_id` from `o_threads` (written at inbound) and refuses a thread it has never seen within the conversation TTL. Slack: `chat.postMessage` with the bot token, `channel` and `thread_ts` from the thread record; DM replies unthreaded unless the door instance says otherwise. Teams: mint the Bot Connector token (single-tenant, `https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token`, scope `https://api.botframework.com/.default`, cached), POST to the stored `service_url` `/v3/conversations/<conversation_id>/activities`; text and files go as separate activities so the message id comes back for the audit row. Both platforms' 429 return `upstream_rate_limited` with `retry_after_ms`; Teams 403 `MessageWritesBlocked` or `ConversationBlockedByUser` return `recipient_blocked`. Requires `idempotency_key`.
- **`POST /v1/door/<kind>/<instance>/notify`** (engine-initiated, protocol 1.2). Starts a conversation with one member where `/send` can only answer inside a thread the outpost already knows; the engine uses it for the weekly curator digest. Body: `{request_id, engine_version, idempotency_key, subject_id, text, format}` with `subject_id` the member's platform id (a Slack user id) and `text`/`format` as in the reply shape (section 5.2, same caps and rendering). Response `{request_id, outpost_version, platform_message_id, thread_id}`. Slack: `conversations.open` with `users: <subject_id>` using the bot token, then `chat.postMessage` into the returned DM channel, unthreaded (a DM reply threads only when the door instance sets `thread_dms`). The adapter then registers the DM in `o_threads` (`platform_key` = the DM channel id per the 1.2 personal-scope rule, `thread_ts` = the posted message, 24-hour TTL), reusing the `thread_id` the DM already has if one exists, so the member's answer arrives as a normal inbound envelope carrying the returned `thread_id` and the engine can continue with `/send`. Dev door: the text is stored as a reply in the dev thread `notify:<subject_id>` and that thread is registered the same way, so a later dev message with that thread id continues the conversation. Errors: 429 returns `upstream_rate_limited` with `retry_after_ms`; Slack `users_not_found`, `user_not_found`, `account_inactive`, `cannot_dm_bot`, `channel_not_found` return `recipient_blocked`; other Slack errors `upstream_error`; a timeout `upstream_timeout`. Idempotency as `/send` (section 9): the key is reserved before the platform call, a replay returns the stored response with `duplicate: true`, and a reservation whose response was never recorded replays as 200 with `platform_message_id: null, thread_id: null, response_lost: true`. Requires `idempotency_key`.
- **`POST /v1/door/<kind>/<instance>/fetch`** (engine-initiated). Body `{attachment_ref}`, an outpost-minted handle resolved from `o_attachments`, never a URL from the engine. Slack: `url_private` with the bot token (`files:read`), host must be `files.slack.com`. Teams v1: personal-chat files only (`application/vnd.microsoft.teams.file.download.info`), fetched promptly from the stored `downloadUrl` with no bearer; the URL is treated as short-lived. Channel and group-chat files return `unavailable` in v1.
- **`POST /door/slack/<instance>/interact`** reserved for Slack's interactivity Request URL (form-encoded `payload`, 200 within 3 seconds). Returns 200 with an empty body in v1 and enqueues nothing. Teams has no separate route: invokes arrive on the main endpoint (above).

### 4.9 Engine-facing routes (outpost calls the engine)

The engine exposes one hostname; the outpost signs with its own key.

- **`POST /v1/inbound`**: one canonical envelope per call, **synchronous**. The engine returns 200 only after it has posted the reply through `/send` (or decided no reply is needed), and a retryable 5xx otherwise. The caller is the outpost's queue consumer, which has a 15-minute budget and holds the connection; the engine stays stateless because the caller holds the in-flight work. The engine deduplicates on `(door_kind, instance, event_id)` through the store (the `o_inbound` row carries a `handled_at` the engine sets via a dedicated `/v1/store/query` write on `k_handled`, see section 7), because queue delivery is at-least-once.
- **`POST /v1/events`**: `{type: "wiped" | "health" | "adapter_error", ...}`.

## 5. Shapes

### 5.1 Canonical inbound envelope

```
{
  "event_id":     "<adapter-composed, see below>",
  "door":         {"kind": "teams", "instance": "main", "adapter_version": "1.0"},
  "thread_id":    "<adapter-minted opaque token>",
  "scope":        "personal" | "group" | "channel",
  "member": {
    "subject_id":   "<Entra aadObjectId | Slack user id>",
    "display_name": "..." | null,
    "groups":       [{"provider": "entra", "id": "<group object id>"}] | null,
    "groups_as_of": "<timestamp>" | null
  },
  "text":            "...",
  "addressed_to_bot": true,
  "mentions":        [{"subject_id", "display_name"}],
  "attachments":     [{"ref", "name", "content_type", "size"}],
  "interaction":     null | {...},
  "received_at":     "<timestamp>"
}
```

`event_id`: Slack = the wrapper's `event_id` (globally unique); Teams = `tenantId + conversation.id + activity.type + activity.id` (activity ids are per-conversation). `thread_id`: opaque; the adapter persists `thread_id -> {platform ids, service_url, conversation_id, tenant_id, scope}` in `o_threads`. Slack encodes `channel:(thread_ts ?? ts)`; Teams stores the conversation id including its `messageid` segment. The engine never constructs or interprets a platform id. `groups` is null when the door cannot supply them (always, in v1, for both platforms); the engine resolves groups through `/v1/source/<graph-instance>` (Teams) or the tenant's override map (Slack) and caches them in `k_members` with a 15-minute TTL. In team scope the adapter also passes `team_group_id` (`channelData.team.aadGroupId`) as a free "everyone in this team" audience id. `display_name` is null on Slack unless the door has `users:read`. Audiences are stored as provider object ids; `everyone` is a literal.

### 5.2 Reply shape

```
{
  "thread_id":  "...",
  "text":       "...",
  "format":     "plain" | "markdown",
  "actions":    []            // reserved, must be empty in v1
}
```

`markdown` maps to Slack `markdown_text` (12,000-character cap; the adapter splits at paragraph boundaries) and to Teams `textFormat: markdown` after downgrading to bold, italic, links, and line breaks (headings, lists, tables, code fences are removed or flattened until `extendedmarkdown` is generally available, then opt-in per door instance). `plain` maps to Slack `text` with `mrkdwn: false` and entity escaping, and to Teams `textFormat: plain`. Teams messages above 80 KB are split. `actions` will be platform-neutral `{id, label, style}` in a later minor; the Teams adapter will render Adaptive Card 1.5 with `Action.Execute` plus `Action.Submit` fallback.

### 5.3 Events

`wiped {confirmed_at, actor}`; `health {inbound_backlog, dlq_backlog, last_forward_at, adapter_errors_24h}`; `adapter_error {door, instance, code}`.

## 6. Credentials and instances (deployed config, never engine-writable)

Instance and credential definitions live in the deployed configuration (`KALTRA_CONFIG`, a JSON var generated per tenant, section 10), not in any table the engine can write. `/v1/meta` exposes them read-only. Changing them is a redeploy by the operator (v0) or a tenant-admin action (later).

Credential:

```
{
  "name":                    "graph-main",           // ^[a-z0-9]+(-[a-z0-9]+)*$
  "type":                    "static_header" | "oauth2_client_credentials" | "hmac_key" | "none",
  "allowed_hosts":           ["graph.microsoft.com"],   // exact match, https only, no ports, no IP literals, no wildcards, no userinfo
  "allowed_methods":         ["GET"],
  "allowed_request_headers": ["content-type", "accept", "consistencylevel"],
  "scopes":                  ["https://graph.microsoft.com/.default"],   // oauth2 only; a credential may declare several
  "config":                  { "tenant_id": "...", "client_id": "...", "header_name": "x-api-key" }
}
```

Type `none` (added with outpost 0.2.0, protocol 1.2 item): nothing is injected and no secret exists for it; the host, method, and header allow-lists apply unchanged. For public or Access-free hosts such as a documentation bucket.

Secret: one Worker secret per credential (none for type `none`), `KALTRA_CRED_<NAME>` (name uppercased, dashes to underscores; the name regex makes the mapping injective), plus optional `KALTRA_CRED_<NAME>_PREV` accepted during rotation for `hmac_key` and `static_header` types. Set with `wrangler secret put` by the operator in v0, or by the tenant through the Cloudflare API (`PUT .../workers/scripts/<name>/secrets`, Workers Scripts Write) later. OAuth2 access tokens are cached in a KV namespace bound to the outpost, keyed by `(credential, scope)`, holding the token and expiry only, never refresh tokens or client secrets; invalidated on 401; excluded from export; cleared on wipe. About 120 credentials per tenant fit under the 128 secrets-plus-vars limit.

URL construction is the outpost's, always: scheme `https`, host chosen by exact match from `allowed_hosts`, path from the header after rejecting `..` and `@` and requiring a single leading `/`, query from the separate header. Request headers not in `allowed_request_headers` are stripped; `authorization`, `cookie`, `host`, `content-length`, `transfer-encoding`, and hop-by-hop headers are always dropped before injection. Redirects are never followed on any upstream fetch (`redirect: "manual"`; the Workers runtime has no `"error"` mode): a 3xx is returned to the engine as the raw upstream status, and the credential has only ever reached the allow-listed host.

Instance: `{id (UUID minted by the dashboard), module, kind, scope, audience, credential, oauth_scope?, timeout_s?}`. One instance, one credential, one OAuth scope. A Teams door instance additionally carries `tenant_id` and `app_type: "single_tenant"`.

## 7. Store

The tenant's D1 database, behind the outpost. Two namespaces:

- **`k_*` (engine-owned, engine-writable through `/v1/store/query`, schema driven by `/v1/store/migrate`):** `k_items_about_me`, `k_items_treats_me`, `k_items_shared` (id, text, kind [fact | preference | rule], audience JSON, author, author_groups_at_save, source_instance, status [proposed | confirmed], created_at, retired_at, format_version), `k_members` (subject_id, platform_user_id, display_name, groups JSON, groups_as_of), `k_conversations` (thread_id, turns JSON, expires_at), `k_config` (curator groups, tenant defaults such as the about-me default audience, Slack group override map), `k_handled` (door_kind, instance, event_id, handled_at), `k_meta` (memory_format_version). Every item in every bucket carries an audience; inherited audience is copied at save time.
- **`o_*` (outpost-owned, never named by an engine statement):** `o_meta` (the outpost's own schema version; the outpost migrates its own tables on first use after an upgrade, no operator step), `o_schema` (applied engine schema version), `o_inbound` (claim-check envelopes and dedup, TTL 7 days), `o_threads` (thread_id to platform ids, TTL = conversation TTL), `o_attachments` (refs to platform URLs, TTL 24 hours), `o_idempotency` (section 9), `o_nonces` (TTL 15 minutes), `o_audit`.

Audit row per protocol call, written by the outpost: `request_id, timestamp, route, actor [engine | tenant | platform], key_id, protocol_version, engine_version, outpost_version, credential_name, instance_id, host (llm, source, fetch), statement_hash (store read) | sql_template (store write, migrate; params never), member_subject_id, bytes_in, bytes_out, tokens_in, tokens_out, model, duration_ms, status, error_code, duplicate, cf_ray`. Never question text, never item text. The engine repository publishes its read-statement catalogue so hashes resolve. Retention is a tenant setting, default 400 days, enforced by the cron; audit rows are never deletable through any engine route.

Cron (`scheduled()` handler, hourly): purge expired `o_nonces`, `o_inbound`, `o_threads`, `o_attachments`, `o_idempotency`, `k_conversations`, and audit rows past retention; refresh the Bot Framework key set.

## 8. Queue and failure semantics

- Inbound: the door adapter writes the envelope to `o_inbound` and enqueues `{event_id}` in a Cloudflare Queue in the tenant's account (Queues are available on the Free plan since 2026-02; Paid is recommended for retention and D1 size). The outpost is producer and consumer; `max_batch_size: 1`.
- Consumer: loads the envelope, calls `/v1/inbound` synchronously, `ack()` on 200. On failure `retry({delaySeconds})` with the schedule 1 s, 10 s, 60 s, 300 s, 600 s, 900 s (`max_retries: 6`, about 31 minutes). On the final attempt the adapter posts the tenant-configurable "unavailable" line to the thread through the same rate limiter, then the message falls to `kaltra-inbound-dlq`. A producer binding to the DLQ lets `/v1/meta` report both backlogs. Delivery is at-least-once, which is why engine dedup on `event_id` is mandatory.
- Outpost down: the platform's own retries fail; the dashboard health check turns red on `/v1/meta` failure; nothing is lost on the engine side because the engine holds nothing.
- Engine down: messages wait in the tenant's queue; nothing is forgotten.

## 9. Idempotency

`o_idempotency` rows are unique on `(route, idempotency_key)` and store `request_hash` (digest of the canonical request), `status`, `response_body` up to 64 KB (else `response_truncated: true`), `created_at`. A repeat with a matching hash returns the stored response with `duplicate: true`; a repeat with a different hash returns `idempotency_conflict`. TTL 7 days.

## 10. Install ("needs")

Tenant provides: a Cloudflare account (Workers Paid recommended), Zero Trust enabled; a zone in that account and a hostname on it for a Workers Custom Domain; an Access application on `/v1/*` with a Service Auth policy and an Allow policy for tenant admins (used only by export and wipe); a D1 location hint (best effort, permanent; read replication enabled in the dashboard after creation); and the platform registrations per door:
- Slack: an app from the published manifest (scopes `chat:write`, `im:history`, `channels:history`, `app_mentions:read`, `files:read`; optional `groups:history`, `users:read`; events `message.im`, `app_mention`, optional `message.channels`; Messages tab on; interactivity URL set to `/door/slack/<instance>/interact`).
- Teams: a single-tenant Azure bot registration and Entra app; an app package (manifest with `botId`, `scopes: [personal, team, groupchat]`, `supportsFiles: true`, `webApplicationInfo.id`) published to the organisation's app catalogue by a Teams administrator, or custom upload enabled for a pilot group by policy; Graph application permission for group reads: `User.Read.All` (least privilege for `transitiveMemberOf`, ids only), admin consent by a Privileged Role Administrator or Global Administrator via the adminconsent URL; for SharePoint sources, `Sites.Selected` (application) consented, then a SharePoint Administrator grants `read` on each site collection an instance covers (`POST /sites/{siteId}/permissions`). Instance scope in v1 is a site collection; a "folder" is a path filter the engine enforces on top, not a Graph boundary (see section 12, fork 3).

Operator does: generate `wrangler.<tenant>.jsonc` from the template (Worker name, `database_id`, Custom Domain, engine URL, `KALTRA_CONFIG` with instances, credentials, doors), `wrangler d1 create --location <hint>`, `wrangler deploy --config` with an account-owned token (Workers Admin on first deploy, then Editor, plus Workers Routes Write and D1/Queues Write), `wrangler secret put` for each credential and the outpost's private key, registration in the dashboard (outpost URL, outpost public key, engine key ids, Access service token), `/v1/store/migrate` to the current schema.

## 11. What is stored where

At the tenant: everything in section 7, the KV token cache, Worker secrets, queue contents, Workers Logs (body capture off).

At the operator: the tenant record only (outpost URL, outpost public key, engine keypair for that tenant, Access service token, a copy of the instance and door config, curator groups, region hint), deleted on off-boarding. No message text, item text, document, attachment, prompt, or reply is stored at the operator. Both sides bind themselves to: no request or response bodies in logs, Workers Logs body capture off, fixed error strings per code, upstream errors reduced to a status and a content-free reason.

Prompts the engine builds pass through the tenant's outpost on the way to the LLM provider; the tenant can read them in their own logs. Prompt secrecy is not part of the product's protection.

## 12. Forks recorded for the owner (all confirmed by the owner, 2026-09-22)

1. **Nonces on read-only requests.** v1.1 stores nonces only for state-changing requests (section 2), keeping read mode on D1 replicas. The alternative is nonces on every request, which routes every read to the D1 primary. Chosen: writes only. Confirmed.
2. **Export and wipe are tenant-admin only.** The operator dashboard has no export button; at tenant zero the operator is the tenant admin. Chosen: tenant-only. Confirmed.
3. **SharePoint instance scope.** `Sites.Selected` is site-collection granularity. A hard lock at folder level needs `Files.SelectedOperations.Selected` grants that break inheritance and add admin steps. Chosen for v1: one site collection per instance, folder as an engine-enforced path filter; a tenant needing a hard lock puts the restricted documents in their own site. Confirmed.
4. **One Entra app for bot and Graph.** A credential may declare several OAuth scopes, token cache keyed by `(credential, scope)`, so one secret serves both. The strict alternative is one scope per credential with the secret stored twice. Chosen: several scopes per credential. Confirmed.
5. **Teams attachments.** Personal chat only in v1. Channel and group-chat files need a Graph files permission and a Graph download path; v1.x. Confirmed.

## 13. Versioning and compatibility

- Protocol version is `major.minor` in `Kaltra-Protocol`, a signed header. Minor versions add routes or optional fields; major versions may remove or change. The outpost's semver tracks the protocol's major.
- The engine supports the current and the previous minor of the outpost. The engine's CI runs the protocol contract tests against the previous tagged outpost release; a red run blocks the engine release.
- A new door kind or credential type bumps the outpost minor version and appears in `/v1/meta`; the engine refuses to install an instance whose kind the outpost does not advertise.

## 14. Tenant zero

The operator's own outpost runs the same code, in the operator's account, on a Custom Domain, with `slack` as the door kind, two Slack user groups mapped to two audiences through the override map, and an R2-backed source instance with one restricted sub-folder. It also tests that the engine-to-outpost call is refused without the service token (whether Access is evaluated on a same-zone Worker subrequest to a Custom Domain is unverified in the docs).

## 15. Protocol 1.2 (planned, from the engine spec review, 2026-09-22)

Minor bump, additive, engine supports 1.1 and 1.2:
- **Personal-scope thread identity.** Implemented 2026-09-23 (Slack adapter 1.1). A DM's `thread_id` maps to the DM channel id (one rolling conversation with the turn TTL), not `channel:ts`; channels keep `channel:thread_ts`. Without this every DM message is its own conversation and one-phrase undo cannot work.
- **Doors are modules (outpost 1.1, 2026-10-19).** The outpost dispatches `/door/<kind>/<instance>`, `/door/<kind>/<instance>/<action>`, `/v1/door/<kind>/<instance>/send` and `/notify`, and the consumer's unavailable line, to the `DoorModule` registered for that kind (`src/doors/registry.ts`, SDK in `src/doors/sdk.ts`). The dev door is in this repository; platform doors are packages a tenant entry point registers. A platform door may show an activity indicator while the engine works and clear it in `afterSend`; what it shows and how is the module's business.
- **Credential type `none`.** Implemented 2026-09-23 (outpost 0.2.0, advertised in `/v1/meta` `credential_types`; the wire version stays 1.1 until the engine negotiates versions per tenant). No header injected; for public or Access-free hosts such as a documentation bucket. Allow-lists still apply.
- **Engine-initiated conversations (`/notify`).** Implemented 2026-09-23 (outpost route `POST /v1/door/<kind>/<instance>/notify`, section 4.8; Slack and dev doors). The engine opens a DM with one member by `subject_id` and the outpost registers the DM as a known thread, so the member's reply comes back as a normal inbound with the same `thread_id`. Needed for the weekly curator digest; `/send` alone can only answer inside a thread the outpost has already seen. Slack needs the `im:write` scope for `conversations.open`.
- **`/v1/events` carries `event_ts`.** The engine ignores events older than the last one it recorded for the tenant, closing the replay gap on the events route.
- **Per-thread read bookmark (later).** The outpost stores the last write bookmark per thread in `o_threads` and applies it to that thread's reads, so a stateless engine gets read-your-writes on replicas. Until then the engine reads `first-primary`.

## 16. Open items for v1.x

- `actions` and the interactive routes (Slack interactivity, Teams `Action.Execute`).
- Tenant self-service secrets page.
- Outpost auto-update.
- Teams channel and group-chat attachments via Graph.
- Attachments above the fetch cap.
- `extendedmarkdown` opt-in once generally available.
- An operator-internal door kind for automated QA at tenant zero.
- `docs/signature-vectors.md`.
