export interface EngineAuth {
  keyId: string;
  nonce: string;
  protocol: string;
}

export interface RouteContext {
  req: Request;
  env: Env;
  params: Record<string, string>;
  body: ArrayBuffer;
  auth: EngineAuth;
  /** Route template, e.g. "/v1/store/query" (never the concrete path with ids). */
  route: string;
  startedAt: number;
}
