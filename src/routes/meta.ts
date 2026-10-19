import { CREDENTIAL_TYPES, LIMITS, OUTPOST_VERSION, engineKeys, parseKaltraConfig } from "../config";
import { appliedSchemaVersion } from "../store/schema";
import { auditStatement } from "../store/audit";
import type { RouteContext } from "../context";

export async function meta(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const config = parseKaltraConfig(env.KALTRA_CONFIG);
  const keys = await engineKeys(env.KALTRA_ENGINE_PUBLIC_KEYS);
  const body = {
    protocol: env.KALTRA_PROTOCOL,
    outpost_version: OUTPOST_VERSION,
    schema_version: await appliedSchemaVersion(env.STORE),
    engine_key_ids: [...keys.keys()],
    door_kinds: [],
    credential_types: [...CREDENTIAL_TYPES],
    instances: config.instances.map((i) => ({ id: i.id, module: i.module, kind: i.kind, scope: i.scope, audience: i.audience, credential: i.credential })),
    region_hint: env.KALTRA_REGION_HINT,
    queues: null,
    limits: LIMITS,
  };
  await env.STORE.batch([
    auditStatement(env.STORE, {
      request_id: crypto.randomUUID(),
      route: ctx.route,
      actor: "engine",
      key_id: ctx.auth.keyId,
      protocol_version: ctx.auth.protocol,
      bytes_in: ctx.body.byteLength,
      duration_ms: Date.now() - ctx.startedAt,
      status: 200,
    }),
  ]);
  return Response.json(body);
}
