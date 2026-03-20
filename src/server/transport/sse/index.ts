/**
 * SSE Transport Module
 *
 * Legacy HTTP+SSE Transport (deprecated protocol 2024-11-05)
 * Still supported for backwards compatibility with older MCP clients.
 *
 * - **SseTransport** — Custom SSE transport implementation (SDK Transport interface)
 * - **SseRequestHandler** — Session lifecycle and message routing
 *
 * @module server/transport/sse
 */

export { SseRequestHandler } from "./handler.js";
export { SseTransport } from "./transport.js";
export type { FlushableResponse } from "./transport.js";
