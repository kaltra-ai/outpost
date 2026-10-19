import { LIMITS } from "../config";
import { errorResponse } from "../errors";
import { findCredential, proxy } from "../proxy/upstream";
import type { RouteContext } from "../context";

export async function llm(ctx: RouteContext): Promise<Response> {
  const cred = findCredential(ctx.env, ctx.params.credential);
  if (!cred) return errorResponse("credential_not_found");
  return proxy(ctx, { credential: cred, timeoutMs: LIMITS.llm_timeout_ms, responseCap: LIMITS.llm_response_bytes, parseUsage: true });
}
