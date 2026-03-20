/**
 * MCP Protocol Version validation middleware
 * MCP Spec 2025-06-18 MUST requirement
 *
 * @module server/middleware/protocol-version
 */

import type { Request, Response, NextFunction } from "express";
import { sanitizeForLog } from "./logging.js";
import { logger as baseLogger } from "../../logger/index.js";
import { HttpStatus, createJsonRpcError, JsonRpcErrorCode } from "../../errors/index.js";
import { MCP_HEADERS } from "../transport/index.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Protocol Version Configuration
// ============================================================================

/**
 * Fallback protocol version for backwards compatibility
 * Used when client doesn't send MCP-Protocol-Version header
 */
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";

const logger = baseLogger.child({ component: "ProtocolVersion" });

/** @internal Log messages for protocol version validation */
const LogMessages = {
  PROTOCOL_VERSION_UNSUPPORTED: "Unsupported protocol version: %s",
} as const;

/**
 * Validates MCP-Protocol-Version header
 * Server MUST respond with 400 Bad Request if version is invalid/unsupported
 */
export function validateProtocolVersion(req: Request, res: Response, next: NextFunction): void {
  const rawVersion = req.headers[MCP_HEADERS.PROTOCOL_VERSION];
  const protocolVersion = typeof rawVersion === "string" ? rawVersion : undefined;

  if (!protocolVersion) {
    // Spec: For backwards compatibility, assume fallback version if no header present
    req.headers[MCP_HEADERS.PROTOCOL_VERSION] = FALLBACK_PROTOCOL_VERSION;
    next();
    return;
  }

  // SUPPORTED_PROTOCOL_VERSIONS is imported from the MCP SDK — always in sync with the SDK version
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    logger.warn(LogMessages.PROTOCOL_VERSION_UNSUPPORTED, sanitizeForLog(protocolVersion));
    res
      .status(HttpStatus.BAD_REQUEST)
      .json(
        createJsonRpcError(
          JsonRpcErrorCode.INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version: ${sanitizeForLog(protocolVersion)}. Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        ),
      );
    return;
  }

  next();
}
