/**
 * Ping Handler
 *
 * Handles ping/pong liveness checks per MCP Specification.
 *
 * Per MCP Spec:
 * - Ping is a standard request that servers SHOULD respond to
 * - Response is an empty object
 * - Used for connection health checks
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping
 * @module mcp/handlers/ping
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger as baseLogger, mcpLogger } from "../../logger/index.js";
import type { PingHandler } from "../types/index.js";

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "ping";

/** @internal Log messages used by the ping handler. */
const LogMessages = {
  PONG_SENT: "🏓 pong",
  PING_RECEIVED: "Received ping, sent pong",
  HANDLER_REGISTERED: "%s handler registered",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Handler Implementation
// ============================================================================

/**
 * Sets up the ping request handler.
 *
 * Registers a handler that responds to ping requests with an empty object
 * and optionally invokes a custom handler for app-specific logic.
 *
 * @internal Called by McpSession during initialization.
 * @param server - The McpServer instance
 * @param onPing - Optional custom handler for app logic (metrics, health tracking, etc.)
 */
export function setupPingHandler(server: McpServer, onPing?: PingHandler): void {
  server.server.setRequestHandler(PingRequestSchema, async (): Promise<Record<string, never>> => {
    // Call custom handler if defined (fire-and-forget, errors logged)
    if (onPing) {
      try {
        await Promise.resolve(onPing());
      } catch (err) {
        logger.warn("Custom ping handler error: %s", err instanceof Error ? err.message : String(err));
      }
    }

    // Log pong via MCP notification (demonstrates server -> client communication)
    mcpLogger.info(LogMessages.PONG_SENT).catch(() => {
      // Ignore errors if client disconnected
    });

    logger.trace(LogMessages.PING_RECEIVED);

    // Return empty object as per MCP spec
    return {};
  });

  logger.trace(LogMessages.HANDLER_REGISTERED, LOG_COMPONENT);
}
