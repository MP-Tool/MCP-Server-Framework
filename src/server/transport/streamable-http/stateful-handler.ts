/**
 * Stateful Streamable HTTP Handler
 *
 * Manages persistent sessions with one SDK transport per client.
 * Session lifecycle is tracked via SessionManager.
 *
 * @module server/transport/streamable-http/stateful-handler
 */

import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { SESSION_CLOSE_REASONS } from "../../session/index.js";
import type { SessionManager } from "../../session/index.js";
import type { SessionFactory } from "../types.js";
import { JsonRpcErrorCode, HttpStatus, TransportErrorMessage } from "../../../errors/index.js";
import { logger as baseLogger } from "../../../logger/index.js";
import { TRANSPORT_LOG_COMPONENTS, MCP_HEADERS, SESSION_ID_QUERY_PARAMS } from "../constants.js";
import { startSseKeepalive } from "../sse-keepalive.js";
import type { TransportRequestHandler } from "./transport.js";
import { sendError, shortId } from "./transport.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.STREAMABLE_HTTP,
});

/** @internal Log messages for stateful handler */
const LogMessages = {
  POST_NO_SESSION: "POST /mcp rejected: missing session ID for non-initialize request",
  POST_SESSION_NOT_FOUND: "POST /mcp rejected: MCP session not found [%s]",
  POST_MESSAGE: "POST /mcp [%s] method=%s",
  SESSION_CREATING: "Creating new MCP session from %s",
  SESSION_INITIALIZED: "MCP Session initialized: %s",
  SESSION_CAPACITY_REACHED: "MCP Session capacity reached, closing transport for %s",
  SESSION_CLOSED: "MCP Session closed: %s",
  GET_SSE_OPENED: "GET /mcp SSE stream opened [%s]",
  GET_SESSION_NOT_FOUND: "GET /mcp rejected: MCP session not found [%s]",
  GET_SESSION_ID_FROM_QUERY:
    "MCP Session ID received via query parameter — prefer Mcp-Session-Id header to avoid URL leakage via Referer/logs",
  SESSION_ID_INJECTED: "Injected MCP session ID into rawHeaders for SSE request",
  GET_ERROR: "Error handling GET for MCP session %s: %s",
  DELETE_ERROR: "Error handling DELETE for MCP session %s: %s",
} as const;

/**
 * Stateful request handler — one SDK transport per persistent session.
 *
 * Manages session creation, lookup, and cleanup via SessionManager.
 */
export class StatefulHandler implements TransportRequestHandler {
  /**
   * Tracks in-flight session creations that have passed the capacity check
   * but haven't yet called sessionManager.create() in the onsessioninitialized callback.
   * Prevents race conditions where concurrent InitializeRequests both pass
   * hasCapacity() before either creates a session.
   */
  private pendingCreations = 0;

  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly sessionManager: SessionManager,
    private readonly enableJsonResponse: boolean,
    private readonly eventStore?: EventStore,
  ) {}

  async handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = this.getSessionId(req);

    // No session + InitializeRequest → create new session
    if (!sessionId && isInitializeRequest(req.body)) {
      await this.createSession(req, res);
      return;
    }

    // No session + non-init request → error
    if (!sessionId) {
      logger.warn(LogMessages.POST_NO_SESSION);
      sendError(res, HttpStatus.BAD_REQUEST, JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.SESSION_ID_REQUIRED);
      return;
    }

    // Existing session → delegate to SDK transport
    const transport = this.getTransport(sessionId);
    if (!transport) {
      logger.warn(LogMessages.POST_SESSION_NOT_FOUND, shortId(sessionId));
      res.status(HttpStatus.NOT_FOUND).send(TransportErrorMessage.SESSION_NOT_FOUND);
      return;
    }

    this.sessionManager.touch(sessionId);

    const method = req.body?.method || "unknown";
    logger.trace(LogMessages.POST_MESSAGE, shortId(sessionId), method);

    await transport.handleRequest(req, res, req.body);
  }

  async handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = this.resolveSessionId(req);

    if (!sessionId) {
      sendError(
        res,
        HttpStatus.BAD_REQUEST,
        JsonRpcErrorCode.SERVER_ERROR,
        TransportErrorMessage.SESSION_ID_OR_PARAM_REQUIRED,
      );
      return;
    }

    const transport = this.getTransport(sessionId);
    if (!transport) {
      logger.warn(LogMessages.GET_SESSION_NOT_FOUND, shortId(sessionId));
      res.status(HttpStatus.NOT_FOUND).send(TransportErrorMessage.SESSION_NOT_FOUND_REINIT);
      return;
    }

    this.sessionManager.touch(sessionId);

    logger.trace(LogMessages.GET_SSE_OPENED, shortId(sessionId));

    /* v8 ignore start - SDK SSE stream handling */
    try {
      this.injectSessionIdHeader(req, sessionId);

      // Start keepalive BEFORE awaiting — the SDK's handleRequest() resolves only
      // when the SSE stream closes (Hono adapter blocks on ReadableStream completion).
      // First keepalive fires after 30s, long after SDK has set SSE headers (<1ms).
      const stopKeepalive = startSseKeepalive(res);
      try {
        await transport.handleRequest(req, res);
      } finally {
        stopKeepalive();
      }
    } catch (error) {
      logger.error(LogMessages.GET_ERROR, sessionId, error);
      sendError(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        JsonRpcErrorCode.INTERNAL_ERROR,
        TransportErrorMessage.INTERNAL_ERROR,
      );
    }
    /* v8 ignore stop */
  }

  async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionId = this.getSessionId(req);

    if (!sessionId) {
      sendError(res, HttpStatus.BAD_REQUEST, JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.SESSION_ID_REQUIRED);
      return;
    }

    const transport = this.getTransport(sessionId);
    if (!transport) {
      res.status(HttpStatus.NOT_FOUND).send(TransportErrorMessage.SESSION_NOT_FOUND);
      return;
    }

    /* v8 ignore start - SDK DELETE handling */
    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error(LogMessages.DELETE_ERROR, sessionId, error);
      sendError(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        JsonRpcErrorCode.INTERNAL_ERROR,
        TransportErrorMessage.INTERNAL_ERROR,
      );
    }
    /* v8 ignore stop */
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Creation
  // ─────────────────────────────────────────────────────────────────────────

  private async createSession(req: Request, res: Response): Promise<void> {
    // Atomic capacity check accounting for in-flight session creations.
    // Without this, concurrent InitializeRequests can both pass hasCapacity()
    // before either calls sessionManager.create(), leading to wasted SDK connections.
    // Node.js is single-threaded: no await between stats read and increment → atomic.
    const { activeCount, maxSessions } = this.sessionManager.stats;
    if (activeCount + this.pendingCreations >= maxSessions) {
      logger.warn(LogMessages.SESSION_CAPACITY_REACHED, "pre-check");
      sendError(
        res,
        HttpStatus.SERVICE_UNAVAILABLE,
        JsonRpcErrorCode.SERVER_ERROR,
        TransportErrorMessage.TOO_MANY_SESSIONS,
      );
      return;
    }

    // Check per-transport limits (e.g., maxStreamableHttpSessions) before SDK handshake.
    // Without this, the SDK sends InitializeResponse but sessionManager.create() rejects
    // in the onsessioninitialized callback, leaving the client with a stale session ID.
    if (!this.sessionManager.hasCapacityForTransport("http")) {
      logger.warn(LogMessages.SESSION_CAPACITY_REACHED, "pre-check (per-transport)");
      sendError(
        res,
        HttpStatus.SERVICE_UNAVAILABLE,
        JsonRpcErrorCode.SERVER_ERROR,
        TransportErrorMessage.TOO_MANY_SESSIONS,
      );
      return;
    }

    this.pendingCreations++;

    // Idempotent slot release — safe to call multiple times (onsessioninitialized, onclose, finally).
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (!slotReleased) {
        slotReleased = true;
        this.pendingCreations--;
      }
    };

    logger.debug(LogMessages.SESSION_CREATING, req.ip || "unknown");

    try {
      const mcpSession = this.sessionFactory();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: this.enableJsonResponse,
        ...(this.eventStore !== undefined && { eventStore: this.eventStore }),
        onsessioninitialized: (sessionId: string) => {
          releaseSlot();
          logger.trace(LogMessages.SESSION_INITIALIZED, shortId(sessionId));
          const session = this.sessionManager.create({
            id: sessionId,
            transportType: "http",
            transport: transport as Transport, // @sdk-constraint — StreamableHTTPServerTransport.onclose is optional, Transport.onclose is not
            mcpSession,
          });

          if (!session) {
            logger.warn(LogMessages.SESSION_CAPACITY_REACHED, shortId(sessionId));
            void transport.close().catch((err: unknown) => {
              logger.warn(
                "Failed to close transport after capacity rejection: %s",
                err instanceof Error ? err.message : String(err),
              );
            });
          }
        },
      });

      /* v8 ignore start - SDK callback registration */
      let transportClosed = false;
      transport.onclose = () => {
        if (transportClosed) return;
        transportClosed = true;
        releaseSlot();
        const sid = transport.sessionId;
        if (sid) {
          logger.trace(LogMessages.SESSION_CLOSED, shortId(sid));
          void this.sessionManager.close(sid, SESSION_CLOSE_REASONS.CLIENT_DISCONNECT).catch((err: unknown) => {
            logger.warn(
              "Error closing session on client disconnect: %s",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      };
      /* v8 ignore stop */

      try {
        await mcpSession.sdk.connect(transport as Transport); // @sdk-constraint — StreamableHTTPServerTransport.onclose is optional, Transport.onclose is not
        await transport.handleRequest(req, res, req.body);
      } catch (connectError) {
        // Cleanup transport and session on connect/handleRequest failure
        // to prevent resource leaks (transport stays open, session never closed).
        try {
          await transport.close();
        } catch {
          // Best-effort — transport may already be closed
        }
        const sid = transport.sessionId;
        if (sid) {
          try {
            await this.sessionManager.close(sid, SESSION_CLOSE_REASONS.ERROR);
          } catch {
            // Best-effort — session may not have been fully created
          }
        }
        throw connectError;
      }
    } finally {
      releaseSlot();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getSessionId(req: Request): string | undefined {
    const value = req.headers[MCP_HEADERS.SESSION_ID];
    return typeof value === "string" ? value : undefined;
  }

  private resolveSessionId(req: Request): string | undefined {
    const headerValue = this.getSessionId(req);
    if (headerValue) return headerValue;

    for (const param of SESSION_ID_QUERY_PARAMS) {
      const value = req.query[param];
      if (typeof value === "string" && value) {
        logger.warn(LogMessages.GET_SESSION_ID_FROM_QUERY);
        return value;
      }
    }

    return undefined;
  }

  private getTransport(sessionId: string): StreamableHTTPServerTransport | undefined {
    const session = this.sessionManager.get(sessionId);
    if (!session) return undefined;
    // @transport-downcast — Sessions in this handler are exclusively created with StreamableHTTP transport
    return session.transport.instance as StreamableHTTPServerTransport;
  }

  private injectSessionIdHeader(req: Request, sessionId: string): void {
    if (!req.headers[MCP_HEADERS.SESSION_ID] && sessionId) {
      req.rawHeaders.push(MCP_HEADERS.SESSION_ID, sessionId);
      // @express-api — IncomingHttpHeaders lacks writable string index; safe mutation for framework-internal header injection
      (req.headers as Record<string, string | string[] | undefined>)[MCP_HEADERS.SESSION_ID] = sessionId;
      logger.trace(LogMessages.SESSION_ID_INJECTED);
    }
  }
}
