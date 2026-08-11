/**
 * Stdio Transport
 *
 * Starts a stdio transport for single-client CLI usage.
 * Creates one McpSession, registers it with the SessionManager,
 * and connects it to stdin/stdout.
 *
 * @module server/transport/stdio-transport
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { TransportHandle, TransportInfo, SessionFactory } from "./types.js";
import type { SessionManager } from "../session/index.js";
import { logger as baseLogger } from "../../logger/index.js";

const logger = baseLogger.child({ component: "StdioTransport" });

const LogMessages = {
  CONNECTING: "Connecting stdio transport...",
  CONNECTED: "Stdio transport connected",
} as const;

// ============================================================================
// Stdio Transport Function
// ============================================================================

/**
 * Starts a stdio transport for single-client CLI usage.
 *
 * Creates a single McpSession, registers it with the SessionManager,
 * and connects it to stdin/stdout via the SDK's StdioServerTransport.
 *
 * @param sessionFactory - Factory to create McpSession instances
 * @param sessionManager - Session manager for lifecycle tracking
 * @returns TransportHandle for shutdown and runtime info
 */
export async function startStdioTransport(
  sessionFactory: SessionFactory,
  sessionManager: SessionManager,
): Promise<TransportHandle> {
  logger.debug(LogMessages.CONNECTING);

  const startedAt = new Date();
  const session = sessionFactory();
  const transport = new StdioServerTransport();

  const created = sessionManager.create({
    transportType: "stdio",
    transport,
    mcpSession: session,
  });

  if (!created) {
    throw new Error("Failed to create stdio session — session capacity reached");
  }

  // Surface the session id the way every other transport does. The SDK builds each
  // request's `extra.sessionId` from `transport.sessionId` (an optional field on the
  // generic Transport interface); `StdioServerTransport` never sets it, so without
  // this line `ToolContext.sessionId` is undefined for stdio only. Consumers that key
  // per-session state on it — the dynamic resource registry, and therefore every
  // payload a tool wants to offload instead of inlining — silently degrade there,
  // even though `resources/read` works perfectly well over stdio.
  //
  // Assigned through `Transport`, which declares the field: the concrete class omits
  // it from its own type even though it implements the interface.
  (transport as Transport).sessionId = created.id;

  await session.sdk.connect(transport);
  logger.debug(LogMessages.CONNECTED);

  return {
    async shutdown(): Promise<void> {
      // No transport-level resources to close for stdio.
      // Session cleanup is handled by McpServerInstance.stop().
    },

    info(): TransportInfo {
      return {
        state: "running",
        startedAt,
        mode: "stdio",
      };
    },
  };
}
