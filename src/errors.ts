// Error responses per docs/protocol-v1.md section 3: fixed message per code, never upstream content.

export type ErrorCode =
  | "invalid_request" | "unauthorized" | "unknown_route" | "credential_not_found" | "instance_not_found"
  | "host_not_allowed" | "method_not_allowed" | "header_not_allowed" | "schema_version_mismatch"
  | "statement_not_allowed" | "statement_failed" | "upstream_error" | "upstream_timeout" | "upstream_rate_limited"
  | "recipient_blocked" | "payload_too_large" | "duplicate" | "idempotency_conflict" | "unavailable" | "internal";

const MESSAGES: Record<ErrorCode, [status: number, message: string, retryable: boolean]> = {
  invalid_request:         [400, "request body is malformed or missing required fields", false],
  unauthorized:            [401, "request is not authenticated", false],
  unknown_route:           [404, "no such route", false],
  credential_not_found:    [404, "no such credential", false],
  instance_not_found:      [404, "no such instance", false],
  host_not_allowed:        [403, "upstream host is not allowed for this credential", false],
  method_not_allowed:      [403, "upstream method is not allowed for this credential", false],
  header_not_allowed:      [403, "upstream header is not allowed for this credential", false],
  schema_version_mismatch: [409, "store schema version does not match", false],
  statement_not_allowed:   [403, "statement is outside the engine namespace or not permitted", false],
  statement_failed:        [422, "an engine statement failed inside the store", false],
  upstream_error:          [502, "upstream returned an error", true],
  upstream_timeout:        [504, "upstream timed out", true],
  upstream_rate_limited:   [429, "upstream rate limited", true],
  recipient_blocked:       [403, "recipient refused the message", false],
  payload_too_large:       [413, "payload exceeds the route cap", false],
  duplicate:               [200, "idempotent replay", false],
  idempotency_conflict:    [409, "idempotency key reused with a different request", false],
  unavailable:             [503, "outpost temporarily unavailable", true],
  internal:                [500, "the outpost hit an unexpected error", true],
};

export function errorResponse(code: ErrorCode, extra: { request_id?: string | null; retry_after_ms?: number; sqlite_code?: string } = {}): Response {
  const [status, message, retryable] = MESSAGES[code];
  return Response.json(
    { request_id: extra.request_id ?? null, error: { code, message, retryable, ...(extra.retry_after_ms !== undefined ? { retry_after_ms: extra.retry_after_ms } : {}), ...(extra.sqlite_code !== undefined ? { sqlite_code: extra.sqlite_code } : {}) } },
    { status },
  );
}
