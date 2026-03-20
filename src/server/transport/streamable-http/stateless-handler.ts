/**
 * Stateless Streamable HTTP Handler
 *
 * Creates a fresh McpSession + SDK transport per request.
 * No session tracking, no persistent connections.
 *
 * @module server/transport/streamable-http/stateless-handler
 */

import type { Request, Response } from "express";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { SessionFactory } from "../types.js";
import { JsonRpcErrorCode, HttpStatus, TransportErrorMessage } from "../../../errors/index.js";
import { logger as baseLogger } from "../../../logger/index.js";
import { TRANSPORT_LOG_COMPONENTS } from "../constants.js";
import type { TransportRequestHandler } from "./transport.js";
import { sendError } from "./transport.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.STREAMABLE_HTTP,
});

/** @internal Log messages for stateless handler */
const LogMessages = {
  STATELESS_POST: "Stateless POST /mcp method=%s",
  STATELESS_ERROR: "Stateless request error: %s",
  STATELESS_CLEANUP_ERROR: "Stateless cleanup error: %s",
  STATELESS_NOT_ALLOWED: "%s not supported in stateless mode",
} as const;

/**
 * Stateless request handler — fresh McpSession + transport per request.
 *
 * Per MCP specification, stateless transports:
 * - Do not emit Mcp-Session-Id headers
 * - Do not support GET SSE streams or DELETE
 * - Cannot be reused across requests (SDK constraint)
 */
export class StatelessHandler implements TransportRequestHandler {
  constructor(
    private readonly sessionFactory: SessionFactory,
    private readonly enableJsonResponse: boolean,
  ) {}

  async handlePost(req: Request, res: Response): Promise<void> {
    const method = req.body?.method || "unknown";
    logger.trace(LogMessages.STATELESS_POST, method);

    try {
      const mcpSession = this.sessionFactory();

      // @ts-expect-error @sdk-constraint — SDK sessionIdGenerator? doesn't accept undefined with exactOptionalPropertyTypes; undefined is the documented mechanism for stateless mode
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: this.enableJsonResponse,
      });

      try {
        // @sdk-constraint — StreamableHTTPServerTransport structurally differs from Transport with exactOptionalPropertyTypes
        await mcpSession.sdk.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body);
      } finally {
        // Cleanup transport + session after the request completes (or fails).
        // Runs even if connect() throws — prevents resource leaks on initialization failure.
        // Use Promise.allSettled to ensure both cleanup steps run even if one fails.
        const results = await Promise.allSettled([transport.close(), mcpSession.dispose()]);
        for (const result of results) {
          if (result.status === "rejected") {
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            logger.warn(LogMessages.STATELESS_CLEANUP_ERROR, reason);
          }
        }
      }
    } catch (error) {
      logger.error(LogMessages.STATELESS_ERROR, error);
      sendError(
        res,
        HttpStatus.INTERNAL_SERVER_ERROR,
        JsonRpcErrorCode.INTERNAL_ERROR,
        TransportErrorMessage.INTERNAL_ERROR,
      );
    }
  }

  async handleGet(_req: Request, res: Response): Promise<void> {
    logger.warn(LogMessages.STATELESS_NOT_ALLOWED, "GET");
    sendError(
      res,
      HttpStatus.METHOD_NOT_ALLOWED,
      JsonRpcErrorCode.METHOD_NOT_FOUND,
      "GET not supported in stateless mode",
    );
  }

  async handleDelete(_req: Request, res: Response): Promise<void> {
    logger.warn(LogMessages.STATELESS_NOT_ALLOWED, "DELETE");
    sendError(
      res,
      HttpStatus.METHOD_NOT_ALLOWED,
      JsonRpcErrorCode.METHOD_NOT_FOUND,
      "DELETE not supported in stateless mode",
    );
  }
}
