/**
 * SSE Request Handler
 *
 * Manages SSE session lifecycle — connection setup, message routing,
 * and cleanup. Parallel to the StreamableHttpTransport's role for
 * the modern Streamable HTTP transport.
 *
 * This handler encapsulates all session management so the SSE router
 * remains a thin routing layer.
 *
 * @module server/transport/sse/handler
 */

import type { Request, Response } from "express";
import { SseTransport } from "./transport.js";
import { createJsonRpcError, JsonRpcErrorCode, HttpStatus, TransportErrorMessage } from "../../../errors/index.js";
import { logger as baseLogger } from "../../../logger/index.js";
import type { SessionFactory } from "../types.js";
import { TRANSPORT_LOG_COMPONENTS, SESSION_ID_DISPLAY_LENGTH } from "../constants.js";
import { SESSION_CLOSE_REASONS } from "../../session/index.js";
import type { SessionManager } from "../../session/index.js";

const logger = baseLogger.child({ component: TRANSPORT_LOG_COMPONENTS.SSE });

/** @internal Log messages for SSE request handler */
const LogMessages = {
  // Connection lifecycle
  SESSION_LIMIT_REACHED: "Session limit reached, rejecting SSE connection",
  SESSION_CREATE_FAILED: "Failed to create SSE session (capacity reached)",
  SESSION_CREATED: "SSE session created: %s",
  SESSION_CLOSED: "SSE session closed: %s",
  SESSION_CONNECTION_ERROR: "MCP session connection error for session %s: %s",
  STREAM_CONNECTED: "SSE stream connected for session: %s",
  CONNECTION_SETUP_ERROR: "Error setting up SSE connection: %s",
  // Message handling
  POST_REJECTED_NO_SESSION_PARAM: "SSE POST %s rejected: missing sessionId query param",
  POST_REJECTED_SESSION_NOT_FOUND: "SSE POST %s rejected: session not found [%s]",
  POST_MESSAGE: "SSE POST %s [%s] method=%s",
  POST_ERROR: "Error handling SSE POST for session %s: %s",
} as const;

// ============================================================================
// SSE Request Handler
// ============================================================================

/**
 * Handles SSE transport session lifecycle and message routing.
 *
 * Manages session creation, connection setup, and message dispatching
 * for the legacy HTTP+SSE transport (deprecated protocol 2024-11-05).
 */
export class SseRequestHandler {
  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly sessionManager: SessionManager,
  ) {}

  // ==========================================================================
  // Connection Handler
  // ==========================================================================

  /**
   * Handle an SSE connection (shared logic for /mcp and /sse endpoints).
   *
   * Creates an SSE stream and connects the MCP server to it.
   * The messageEndpoint parameter determines where clients should POST messages to.
   *
   * Note: mcpServer.connect() automatically calls transport.start() internally,
   * which sends the 'endpoint' SSE event with the message URL containing the sessionId.
   *
   * NOTE: This function requires real SSE connections for full test coverage.
   */
  /* v8 ignore start - SSE requires real SSE connections for testing */
  async handleConnection(req: Request, res: Response, messageEndpoint: string): Promise<void> {
    // Check session limits: global capacity AND per-transport (SSE) limit.
    // Both checks must pass before starting the SSE stream to avoid sending
    // SSE headers and then immediately rejecting the session in create().
    if (!this.sessionManager.hasCapacity() || !this.sessionManager.hasCapacityForTransport("sse")) {
      logger.warn(LogMessages.SESSION_LIMIT_REACHED);
      res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.TOO_MANY_SESSIONS));
      return;
    }

    try {
      // Create our custom SSE transport
      const transport = new SseTransport(messageEndpoint, res);

      // Start the transport first (sends endpoint event with sessionId)
      await transport.start();

      // Get the sessionId that was sent to the client in the endpoint event
      const sessionId = transport.sessionId;

      // Create MCP session instance
      const mcpSession = this.sessionFactory();

      // IMPORTANT: Create unified session BEFORE connecting MCP session!
      const session = this.sessionManager.create({
        id: sessionId,
        transportType: "sse",
        transport,
        mcpSession,
      });

      if (!session) {
        logger.warn(LogMessages.SESSION_CREATE_FAILED);
        // After transport.start(), SSE headers are already sent — cannot send JSON error.
        // Close the transport; the client will detect the disconnection.
        if (!res.headersSent) {
          res
            .status(HttpStatus.SERVICE_UNAVAILABLE)
            .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.TOO_MANY_SESSIONS));
        }
        await transport.close();
        return;
      }

      logger.debug(LogMessages.SESSION_CREATED, sessionId);

      // Guard against duplicate close (transport.onclose + req.on('close') fire independently)
      let closed = false;
      const closeOnce = (): void => {
        if (closed) return;
        closed = true;
        logger.debug(LogMessages.SESSION_CLOSED, sessionId);
        void this.sessionManager.close(sessionId, SESSION_CLOSE_REASONS.CLIENT_DISCONNECT).catch((err) => {
          logger.warn(
            "Error closing session on client disconnect: %s",
            err instanceof Error ? err.message : String(err),
          );
        });
      };

      // Handle cleanup when connection closes
      transport.onclose = closeOnce;

      // Also handle request close/error
      req.on("close", closeOnce);

      // Connect MCP session to transport
      // Note: This is intentionally NOT awaited because connect() may block
      // waiting for the initialize message from the client.
      mcpSession.sdk.connect(transport).catch((err) => {
        logger.error(LogMessages.SESSION_CONNECTION_ERROR, sessionId, err);
        void this.sessionManager.close(sessionId, SESSION_CLOSE_REASONS.ERROR).catch((closeErr) => {
          logger.warn(
            "Error closing session after connection failure: %s",
            closeErr instanceof Error ? closeErr.message : String(closeErr),
          );
        });
      });

      logger.debug(LogMessages.STREAM_CONNECTED, sessionId);
    } catch (error) {
      logger.error(LogMessages.CONNECTION_SETUP_ERROR, error);
      if (!res.headersSent) {
        res
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .json(createJsonRpcError(JsonRpcErrorCode.INTERNAL_ERROR, TransportErrorMessage.INTERNAL_ERROR));
      }
    }
  }
  /* v8 ignore stop */

  // ==========================================================================
  // Message Handler
  // ==========================================================================

  /**
   * Handle an incoming POST message for an SSE session.
   *
   * Looks up the session by query parameter, validates it, and delegates
   * the message to the session's SseTransport.
   */
  /* v8 ignore start - SSE session handling */
  async handleMessage(req: Request, res: Response, endpoint: string): Promise<void> {
    const rawSessionId = req.query.sessionId;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;

    if (!sessionId) {
      logger.warn(LogMessages.POST_REJECTED_NO_SESSION_PARAM, endpoint);
      res
        .status(HttpStatus.BAD_REQUEST)
        .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.SESSION_ID_QUERY_REQUIRED));
      return;
    }

    const session = this.sessionManager.get(sessionId);
    if (!session || session.transport.type !== "sse") {
      logger.warn(
        LogMessages.POST_REJECTED_SESSION_NOT_FOUND,
        endpoint,
        sessionId.substring(0, SESSION_ID_DISPLAY_LENGTH),
      );
      res
        .status(HttpStatus.NOT_FOUND)
        .json(createJsonRpcError(JsonRpcErrorCode.SESSION_NOT_FOUND, TransportErrorMessage.SESSION_NOT_FOUND));
      return;
    }

    // Update session activity timestamp (idle timeout tracking)
    this.sessionManager.touch(sessionId);

    try {
      const method = req.body?.method || "unknown";
      logger.debug(LogMessages.POST_MESSAGE, endpoint, sessionId.substring(0, SESSION_ID_DISPLAY_LENGTH), method);
      // @transport-downcast — Sessions in this handler are exclusively created with SSE transport
      const transport = session.transport.instance as SseTransport;
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error(LogMessages.POST_ERROR, sessionId, error);
      if (!res.headersSent) {
        res
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .json(createJsonRpcError(JsonRpcErrorCode.INTERNAL_ERROR, TransportErrorMessage.INTERNAL_ERROR));
      }
    }
  }
  /* v8 ignore stop */
}
