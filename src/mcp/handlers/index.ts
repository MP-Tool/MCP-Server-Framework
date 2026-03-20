/**
 * MCP Protocol Handlers Module
 *
 * Setup functions for MCP protocol request/notification handlers.
 *
 * - **Ping Handler**: Responds to client liveness checks
 * - **Progress Reporter**: Rate-limited progress notifications
 *
 * Cancellation is handled natively by the MCP SDK's Protocol layer.
 * The SDK creates per-request AbortControllers and automatically aborts
 * them when `notifications/cancelled` is received. No custom handler needed.
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
 * @module mcp/handlers
 */

// ============================================================================
// Handler Setup Functions
// @internal Used by McpSession during initialization
// ============================================================================

export { setupPingHandler } from "./ping.js";

// ============================================================================
// Progress Utilities
// ============================================================================

export { createProgressReporter } from "./progress.js";
