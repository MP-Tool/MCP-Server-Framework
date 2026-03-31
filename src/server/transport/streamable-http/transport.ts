/**
 * Streamable HTTP Transport
 *
 * Facade that delegates HTTP requests to the appropriate strategy handler
 * based on the configured mode (stateful or stateless).
 *
 * Architecture:
 *   Express Route → StreamableHttpTransport → Strategy Handler → SDK Transport → McpServer
 *
 * The SDK transport handles all MCP protocol concerns:
 * - JSON-RPC 2.0 parsing and validation
 * - Content-Type and Accept header validation
 * - Session ID management (header setting/checking)
 * - SSE stream setup for server-to-client notifications
 * - Session termination
 *
 * This transport manages:
 * - Strategy selection (stateful vs stateless)
 * - HTTP method routing (POST, GET, DELETE)
 * - Error responses for unsupported methods
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * @module server/transport/streamable-http/transport
 */

import type { Request, Response } from "express";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { SessionManager } from "../../session/index.js";
import type { SessionFactory } from "../types.js";
import { HttpStatus, TransportErrorMessage, JsonRpcErrorCode, createJsonRpcError } from "../../../errors/index.js";
import { logger as baseLogger } from "../../../logger/index.js";
import { TRANSPORT_LOG_COMPONENTS, SESSION_ID_DISPLAY_LENGTH } from "../constants.js";

import { StatefulHandler } from "./stateful-handler.js";
import { StatelessHandler } from "./stateless-handler.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.STREAMABLE_HTTP,
});

// ============================================================================
// Strategy Interface
// ============================================================================

/**
 * Strategy interface for handling Streamable HTTP transport requests.
 *
 * Implemented by:
 * - {@link StatefulHandler} — one SDK transport per persistent session
 * - {@link StatelessHandler} — fresh McpSession + transport per request
 */
export interface TransportRequestHandler {
  handlePost(req: Request, res: Response): Promise<void>;
  handleGet(req: Request, res: Response): Promise<void>;
  handleDelete(req: Request, res: Response): Promise<void>;
}

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Sends a JSON-RPC error response if headers haven't been sent.
 */
export function sendError(res: Response, status: number, code: number, message: string): void {
  if (!res.headersSent) {
    res.status(status).json(createJsonRpcError(code, message));
  }
}

/**
 * Shortens a session ID for log display.
 */
export function shortId(sessionId: string): string {
  return sessionId.substring(0, SESSION_ID_DISPLAY_LENGTH);
}

/** @internal Log messages for transport router */
const LogMessages = {
  METHOD_NOT_ALLOWED: "%s /mcp rejected: method not allowed",
  UNHANDLED_ERROR: "Unhandled error in request handler: %s",
} as const;

// ============================================================================
// Options
// ============================================================================

/**
 * Configuration options for the Streamable HTTP transport.
 */
export interface StreamableHttpTransportOptions {
  /** Operate in stateless mode (no session IDs). Default: false */
  readonly stateless?: boolean | undefined;

  /**
   * Optional event store for stream resumability.
   *
   * When provided, the SDK transport stores SSE events and supports
   * client reconnection via the `Last-Event-ID` header. Only meaningful
   * in stateful mode — stateless requests have no persistent streams.
   *
   * The SDK provides {@link InMemoryEventStore} as a reference implementation.
   * For production horizontal scaling, implement the {@link EventStore} interface
   * with Redis, PostgreSQL, or another shared backend.
   *
   * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
   */
  readonly eventStore?: EventStore | undefined;

  /**
   * Prefer JSON responses over SSE for simple request-response.
   *
   * When true, the SDK returns `application/json` for non-streaming
   * responses instead of `text/event-stream` SSE envelopes.
   *
   * MCP spec: "If the server is only sending one response with no
   * notifications, it SHOULD prefer application/json."
   *
   * @default true
   */
  readonly enableJsonResponse?: boolean | undefined;
}

// ============================================================================
// Transport Facade
// ============================================================================

/**
 * Routes HTTP requests to the appropriate strategy handler.
 *
 * In stateful mode (default): delegates to {@link StatefulHandler}
 * In stateless mode: delegates to {@link StatelessHandler}
 *
 * All MCP protocol handling is delegated through the handler chain
 * to the SDK's StreamableHTTPServerTransport.
 */
export class StreamableHttpTransport {
  private readonly handler: TransportRequestHandler;
  private readonly sessionManager: SessionManager;

  constructor(
    sessionFactory: SessionFactory,
    sessionManager: SessionManager,
    options: StreamableHttpTransportOptions = {},
  ) {
    this.sessionManager = sessionManager;
    const enableJsonResponse = options.enableJsonResponse ?? false;

    this.handler = options.stateless
      ? new StatelessHandler(sessionFactory, enableJsonResponse)
      : new StatefulHandler(sessionFactory, sessionManager, enableJsonResponse, options.eventStore);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Handle an incoming HTTP request by delegating to the appropriate
   * strategy handler.
   *
   * This is the single entry point called by Express route handlers.
   * Security middleware (DNS rebinding, rate limiting, protocol version)
   * runs BEFORE this method is called.
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    try {
      switch (req.method) {
        case "POST":
          await this.handler.handlePost(req, res);
          break;
        case "GET":
          await this.handler.handleGet(req, res);
          break;
        case "DELETE":
          await this.handler.handleDelete(req, res);
          break;
        default:
          logger.warn(LogMessages.METHOD_NOT_ALLOWED, req.method);
          sendError(
            res,
            HttpStatus.METHOD_NOT_ALLOWED,
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method ${req.method} not allowed`,
          );
      }
    } catch (error) {
      logger.error(LogMessages.UNHANDLED_ERROR, error);
      sendError(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        JsonRpcErrorCode.INTERNAL_ERROR,
        TransportErrorMessage.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Number of active stateful sessions.
   * Returns 0 in stateless mode (no session tracking).
   */
  get activeSessionCount(): number {
    return this.sessionManager.size;
  }
}
