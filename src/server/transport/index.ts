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
// Streamable HTTP Transport
// ============================================================================

export { createInMemoryEventStore } from "./streamable-http/index.js";
export type { InMemoryEventStoreOptions, InMemoryEventStoreResult } from "./streamable-http/index.js";

// ============================================================================
// Constants (public)
// ============================================================================

export { MCP_HEADERS } from "./constants.js";
