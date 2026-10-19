import { LIMITS, parseKaltraConfig } from "../config";
import { errorResponse } from "../errors";
import { findCredential, proxy } from "../proxy/upstream";
import type { RouteContext } from "../context";

export async function source(ctx: RouteContext): Promise<Response> {
  const instance = parseKaltraConfig(ctx.env.KALTRA_CONFIG).instances.find((i) => i.id === ctx.params.instance);
  if (!instance) return errorResponse("instance_not_found");
  const cred = findCredential(ctx.env, instance.credential);
  if (!cred) return errorResponse("credential_not_found");
  const timeoutMs = Math.min(Math.max((instance.timeout_s ?? 30) * 1000, 1000), 60_000);
  return proxy(ctx, { credential: cred, scope: instance.oauth_scope, instanceId: instance.id, timeoutMs, responseCap: LIMITS.source_response_bytes, parseUsage: false });
}
