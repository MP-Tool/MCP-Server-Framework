/**
 * Streamable HTTP Express Router
 *
 * Thin routing layer that delegates all MCP protocol handling to the SDK
 * via the StreamableHttpTransport.
 *
 * Responsibilities:
 * - Express routing (POST/GET/DELETE /mcp)
 * - Method rejection (405 for unsupported methods)
 *
 * Protocol handling (JSON-RPC, sessions, SSE) is fully delegated
 * to the StreamableHttpTransport → SDK StreamableHTTPServerTransport chain.
 *
 * Security middleware (DNS rebinding, rate limiting, protocol version)
 * is applied at the Express app level BEFORE this router.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * @module server/routes/streamable-http-router
 */

import { Router, type Request, type Response } from "express";
import {
  StreamableHttpTransport,
  type StreamableHttpTransportOptions,
} from "../transport/streamable-http/transport.js";
import type { SessionManager } from "../session/index.js";
import type { SessionFactory } from "../transport/types.js";
import { createJsonRpcError, JsonRpcErrorCode, HttpStatus } from "../../errors/index.js";

// ============================================================================
// Router Factory
// ============================================================================

/**
 * Creates the MCP Streamable HTTP router.
 *
 * The router is intentionally thin — all protocol logic lives in
 * the SDK transport, managed by the StreamableHttpTransport.
 *
 * @param sessionFactory - Factory to create McpSession instances
 * @param sessionManager - Session manager for tracking active sessions
 * @param options - Transport options (stateless mode, etc.)
 * @returns Express Router to be mounted at /mcp
 */
export function createStreamableHttpRouter(
  sessionFactory: SessionFactory,
  sessionManager: SessionManager,
  options?: StreamableHttpTransportOptions,
): Router {
  const handler = new StreamableHttpTransport(sessionFactory, sessionManager, options);
  const router = Router();

  // All MCP protocol traffic is delegated to the SDK via the handler.
  // Express 5 catches rejected promises from async route handlers automatically.
  router.post("/", async (req: Request, res: Response) => {
    await handler.handleRequest(req, res);
  });

  router.get("/", async (req: Request, res: Response) => {
    await handler.handleRequest(req, res);
  });

  router.delete("/", async (req: Request, res: Response) => {
    await handler.handleRequest(req, res);
  });

  // Reject unsupported methods
  router.all("/", (_req: Request, res: Response) => {
    res
      .status(HttpStatus.METHOD_NOT_ALLOWED)
      .json(createJsonRpcError(JsonRpcErrorCode.METHOD_NOT_FOUND, "Method not allowed"));
  });

  return router;
}
