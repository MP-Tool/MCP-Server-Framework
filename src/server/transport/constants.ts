/**
 * Transport Constants
 *
 * Central place for all transport-layer constants:
 * log component names, route paths, MCP headers, query parameters, and SSE events.
 *
 * Eliminates magic strings across the transport module.
 *
 * @module server/transport/constants
 */

// ============================================================================
// Log Components
// ============================================================================

/**
 * Logger component names for transport layer.
 * Used for consistent log categorization.
 */
export const TRANSPORT_LOG_COMPONENTS = {
  /** Main HTTP server */
  HTTP_SERVER: "HttpServer",
  /** Streamable HTTP transport */
  STREAMABLE_HTTP: "StreamableHttp",
  /** Legacy SSE transport */
  SSE: "Sse",
  /** Rate limiting @public — available for consumer transport implementations */
  RATE_LIMIT: "RateLimit",
  /** DNS rebinding protection @public — available for consumer transport implementations */
  DNS_PROTECTION: "DnsProtection",
  /** Session management @public — available for consumer transport implementations */
  SESSION: "Session",
  /** Health endpoints @public — available for consumer transport implementations */
  HEALTH: "Health",
  /** Security (TLS, credentials) */
  SECURITY: "Security",
  /** TLS certificate operations @public — available for consumer transport implementations */
  TLS: "Tls",
  /** SSE stream keepalive (shared across Streamable HTTP and SSE transports) */
  SSE_KEEPALIVE: "SseKeepalive",
} as const;

// ============================================================================
// Route Paths
// ============================================================================

/**
 * All route paths used in the transport layer.
 */
export const TRANSPORT_ROUTES = {
  /** Primary MCP endpoint for Streamable HTTP transport */
  MCP: "/mcp",
  /** SSE connection endpoint (legacy transport, deprecated 2024-11-05) */
  SSE: "/sse",
  /** SSE message endpoint for connections via /sse */
  SSE_MESSAGE: "/sse/message",
  /** SSE message endpoint for connections via /mcp */
  MCP_MESSAGE: "/mcp/message",
  /** Health check endpoint */
  HEALTH: "/health",
  /** Readiness check endpoint */
  READY: "/ready",
  /** Prometheus metrics endpoint (available when OTEL is enabled) */
  METRICS: "/metrics",
} as const;

// ============================================================================
// MCP Headers
// ============================================================================

/**
 * HTTP header names defined by the MCP specification.
 */
export const MCP_HEADERS = {
  /** Session identifier header (MCP 2025-03-26) */
  SESSION_ID: "mcp-session-id",
  /** Protocol version header (MCP 2025-03-26) */
  PROTOCOL_VERSION: "mcp-protocol-version",
} as const;

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * Query parameter name accepted as session ID fallback.
 *
 * For clients that cannot set custom HTTP headers (e.g. browser EventSource),
 * the session ID can be provided via query parameter.
 *
 * Uses a single canonical name to minimize attack surface (DD-023).
 */
export const SESSION_ID_QUERY_PARAMS = ["sessionId"] as const;

// ============================================================================
// SSE Keepalive
// ============================================================================

/**
 * SSE stream keepalive configuration.
 *
 * Idle SSE streams (GET /mcp, GET /sse) are terminated by TCP/proxy idle
 * timeouts (typically ~5 minutes). Periodic SSE comments prevent this.
 *
 * Per WHATWG SSE Spec Section 9.2.7:
 * "Legacy proxy servers are known to drop HTTP connections after a short timeout.
 *  Authors can include a comment line (one starting with ':') every 15 seconds or so."
 *
 * SSE comments (lines starting with ':') are silently discarded by the parser
 * (Section 9.2.6) — no impact on MCP protocol or client behavior.
 */
export const SSE_KEEPALIVE = {
  /** SSE comment written to keep the stream alive. Spec-compliant ':' prefix. */
  COMMENT: ":keepalive\n\n",
  /** Interval between keepalive comments (ms). 30s balances spec guidance (15s) with modern stacks. */
  INTERVAL_MS: 30_000,
} as const;

// ============================================================================
// SSE Events
// ============================================================================

/**
 * Server-Sent Event names used by the SSE transport.
 */
export const SSE_EVENTS = {
  /** Connection handshake event (sends message endpoint URL) */
  ENDPOINT: "endpoint",
  /** JSON-RPC message event */
  MESSAGE: "message",
} as const;

// ============================================================================
// Session Display
// ============================================================================

/**
 * Number of characters to display for shortened session IDs in logs.
 */
export const SESSION_ID_DISPLAY_LENGTH = 8;
