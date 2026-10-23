// Result shape returned by every tool. Tools never throw to the model: a
// failure is returned as data so the model can read it and respond honestly.

export type ToolErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_eligible'
  | 'limit_reached'
  | 'timeout'
  | 'server_error'
  | 'rate_limited'
  | 'malformed_response'
  | 'internal_error';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  // True when trying again later might succeed (an outage, not a refusal).
  retryable: boolean;
  // How many times the gateway tried the failing backend call.
  attempts?: number;
}

export type ToolResult<T = unknown> = { ok: true; data: T } | { ok: false; error: ToolError };
