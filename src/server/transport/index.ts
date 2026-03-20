/**
 * Transport Layer — Public API
 *
 * MCP protocol transports: Stdio and Streamable HTTP (2025-03-26),
 * with optional SSE backwards compatibility (2024-11-05).
 *
 * HTTP infrastructure (Express app, HTTP/S server) is in server/http/.
 * Express routers are in server/routes/.
 * Middleware is in server/middleware/.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 *
 * @module server/transport
 */

// ============================================================================
// Types (public contract)
// ============================================================================

export type {
  SessionFactory,
  TransportHandle,
  TransportInfo,
  TransportType,
  TransportState,
  HeartbeatCapableTransport,
  HeartbeatState,
  TransportContext,
} from "./types.js";

export { createTransportContext, isHeartbeatCapable } from "./types.js";

// ============================================================================
// Transport Functions
// ============================================================================

export { startStdioTransport } from "./stdio-transport.js";

// ============================================================================
// Streamable HTTP Transport
// ============================================================================

export { StreamableHttpTransport } from "./streamable-http/index.js";
export type { StreamableHttpTransportOptions } from "./streamable-http/index.js";

// ============================================================================
// Constants (public)
// ============================================================================

export { MCP_HEADERS } from "./constants.js";
