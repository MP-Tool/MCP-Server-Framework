/**
 * SSE Transport Router
 *
 * Thin routing layer for the legacy HTTP+SSE transport (deprecated protocol 2024-11-05).
 * All session management and message handling is delegated to the SseRequestHandler.
 *
 * Endpoints:
 * - GET /sse → Opens SSE stream, sends endpoint event with message URL
 * - POST /message?sessionId=xxx → Receives JSON-RPC messages
 * - POST /mcp/message?sessionId=xxx → Alternative message endpoint (for /mcp SSE)
 *
 * @module server/routes/sse-router
 */

import { Router, type Request, type Response } from "express";
import { SseRequestHandler } from "../transport/sse/handler.js";
import { createJsonRpcError, JsonRpcErrorCode, HttpStatus, TransportErrorMessage } from "../../errors/index.js";
import { getFrameworkConfig } from "../../config/index.js";
import { logger as baseLogger } from "../../logger/index.js";
import type { SessionFactory } from "../transport/types.js";
import { TRANSPORT_LOG_COMPONENTS, TRANSPORT_ROUTES } from "../transport/constants.js";
import type { SessionManager } from "../session/index.js";

const logger = baseLogger.child({ component: TRANSPORT_LOG_COMPONENTS.SSE });

/** @internal Log messages for SSE router */
const LogMessages = {
  TRANSPORT_ENABLED: "SSE transport enabled (deprecated protocol 2024-11-05)",
  CLIENT_CONNECTING: "SSE client connecting via /sse from %s",
} as const;

// ============================================================================
// SSE Config Helpers
// ============================================================================

/**
 * Check if legacy SSE transport is enabled.
 *
 * Reads from the cached framework config (`MCP_LEGACY_SSE_ENABLED`).
 *
 * @returns true if SSE transport is enabled
 */
export function isSseEnabled(): boolean {
  return getFrameworkConfig().MCP_LEGACY_SSE_ENABLED;
}

/**
 * Get the number of active SSE sessions from the session manager.
 *
 * @param sessionManager - Unified session manager
 * @returns Number of active SSE sessions
 */
export function getSseSessionCount(sessionManager: SessionManager): number {
  return sessionManager.getByTransportType("sse").length;
}

// ============================================================================
// SSE Router Factory
// ============================================================================

/**
 * Creates the SSE Router (deprecated HTTP+SSE transport from protocol 2024-11-05).
 *
 * The router is intentionally thin — all session management and
 * message handling is delegated to the SseRequestHandler.
 *
 * @param sessionFactory - Factory to create McpSession instances
 * @param sessionManager - Session manager for tracking active sessions
 * @returns Express Router with SSE endpoints
 */
export function createSseRouter(sessionFactory: SessionFactory, sessionManager: SessionManager): Router {
  const router = Router();
  const config = getFrameworkConfig();

  if (!config.MCP_LEGACY_SSE_ENABLED) {
    // Return router with endpoints that indicate feature is disabled
    const disabledHandler = (_req: Request, res: Response) => {
      res
        .status(HttpStatus.NOT_IMPLEMENTED)
        .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.SSE_DISABLED));
    };
    router.get(TRANSPORT_ROUTES.SSE, disabledHandler);
    router.post(TRANSPORT_ROUTES.SSE_MESSAGE, disabledHandler);
    router.post(TRANSPORT_ROUTES.MCP_MESSAGE, disabledHandler);
    return router;
  }

  logger.info(LogMessages.TRANSPORT_ENABLED);

  const handler = new SseRequestHandler(sessionFactory, sessionManager);

  /* v8 ignore start - SSE routes require real SSE transport */
  router.get(TRANSPORT_ROUTES.SSE, async (req: Request, res: Response) => {
    logger.info(LogMessages.CLIENT_CONNECTING, req.ip || "unknown");
    await handler.handleConnection(req, res, TRANSPORT_ROUTES.SSE_MESSAGE);
  });

  router.post(TRANSPORT_ROUTES.SSE_MESSAGE, async (req: Request, res: Response) => {
    await handler.handleMessage(req, res, TRANSPORT_ROUTES.SSE_MESSAGE);
  });
  /* v8 ignore stop */

  router.post(TRANSPORT_ROUTES.MCP_MESSAGE, async (req: Request, res: Response) => {
    await handler.handleMessage(req, res, TRANSPORT_ROUTES.MCP_MESSAGE);
  });

  return router;
}
