/**
 * Transport Error Messages
 *
 * String constants used by transport layer code (SSE handler, Streamable HTTP, middleware)
 * to return protocol-level error messages in HTTP responses.
 *
 * These are static strings (no interpolation needed) — each maps a short semantic key
 * to the user-facing error message string.
 *
 * @module errors/core/messages
 */

// ============================================================================
// Transport Error Message Mapping
// ============================================================================

/**
 * Transport-specific error message constants.
 *
 * Provides a convenient API for transport layer code to reference
 * standardized error messages.
 *
 * @example
 * ```typescript
 * import { TransportErrorMessage } from '../errors/index.js';
 *
 * res.status(HttpStatus.BAD_REQUEST)
 *    .json({ error: TransportErrorMessage.SESSION_ID_REQUIRED });
 * ```
 */
export const TransportErrorMessage = {
  // Session errors
  SESSION_ID_REQUIRED: "Mcp-Session-Id header required",
  SESSION_ID_OR_PARAM_REQUIRED: "Mcp-Session-Id header or sessionId query parameter required",
  SESSION_NOT_FOUND: "Session not found or expired",
  SESSION_NOT_FOUND_REINIT: "Session has expired. Please re-initialize.",
  TOO_MANY_SESSIONS: "Service unavailable: too many active sessions",

  // Content errors
  MISSING_ACCEPT_HEADER: "Missing Accept header",
  INVALID_ACCEPT_HEADER: "Invalid Accept header",
  INVALID_CONTENT_TYPE: "Content-Type must be application/json",
  INVALID_JSON: "Invalid JSON",
  INVALID_JSONRPC: "Invalid JSON-RPC version",
  INVALID_JSONRPC_VERSION: "JSON-RPC version must be 2.0",
  INVALID_JSONRPC_BATCH: "Invalid batch request: array must not be empty",
  MISSING_JSONRPC_METHOD: "Missing method field",

  // Security errors
  DNS_REBINDING_BLOCKED: "Forbidden: Invalid Host header",
  ORIGIN_NOT_ALLOWED: "Forbidden: Invalid Origin header",
  RATE_LIMIT_EXCEEDED: "Too many requests from this IP, please try again later.",
  PROXY_NOT_CONFIGURED: "Bad Gateway: proxy headers detected but trust proxy is not configured",

  // Transport state
  TRANSPORT_CLOSED: "Transport is closed",

  // Protocol
  UNSUPPORTED_PROTOCOL_VERSION: "Unsupported MCP-Protocol-Version",
  SSE_DISABLED: "SSE transport is disabled. Enable with MCP_LEGACY_SSE_ENABLED=true or use Streamable HTTP transport.",
  SESSION_ID_QUERY_REQUIRED: "sessionId query parameter required",

  // Generic
  INTERNAL_ERROR: "An internal error occurred",
} as const;

export type TransportErrorMessageKey = keyof typeof TransportErrorMessage;
