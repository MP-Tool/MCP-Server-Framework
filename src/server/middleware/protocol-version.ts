/**
 * MCP Protocol Version validation middleware
 * MCP Spec 2025-06-18 MUST requirement
 *
 * @module server/middleware/protocol-version
 */

import type { Request, Response, NextFunction } from "express";
import { truncateForLog } from "./logging.js";
import { logger as baseLogger } from "../../logger/index.js";
import { HttpStatus, createJsonRpcError, JsonRpcErrorCode } from "../../errors/index.js";
import { MCP_HEADERS } from "../transport/index.js";
import { SUPPORTED_PROTOCOL_VERSIONS, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const logger = baseLogger.child({ component: "ProtocolVersion" });

/** @internal Log messages for protocol version validation */
const LogMessages = {
  PROTOCOL_VERSION_UNSUPPORTED: "Unsupported protocol version: %s",
} as const;

/**
 * Validates the `MCP-Protocol-Version` header on `/mcp` requests.
 *
 * Per the MCP spec the header is only sent on requests *following* initialization —
 * the `initialize` request carries the client's requested version in its JSON-RPC body
 * and is negotiated there by the SDK. So this middleware:
 *
 * - **exempts the `initialize` request** entirely (no header expected; leaving it untouched
 *   lets the SDK negotiate in the body — the reason auto-negotiation must not be second-guessed
 *   at the HTTP layer),
 * - lets a non-initialize request without the header pass, for which the SDK assumes the
 *   spec default (`DEFAULT_NEGOTIATED_PROTOCOL_VERSION`, currently `2025-03-26`), and
 * - responds `400` when a present header is not in `SUPPORTED_PROTOCOL_VERSIONS`.
 *
 * `req.body` is already JSON-parsed upstream (the json body parser is mounted before this),
 * so {@link isInitializeRequest} can inspect it.
 */
export function validateProtocolVersion(req: Request, res: Response, next: NextFunction): void {
  // The initialize request negotiates its version in the body; the header does not apply yet.
  // Passing it through untouched is what keeps SDK auto-negotiation working.
  if (isInitializeRequest(req.body)) {
    next();
    return;
  }

  const rawVersion = req.headers[MCP_HEADERS.PROTOCOL_VERSION];
  const protocolVersion = typeof rawVersion === "string" ? rawVersion : undefined;

  if (!protocolVersion) {
    // Spec: when no header is present, the default negotiated version applies. The SDK assumes
    // it itself, it reads the raw headers and would not see a value set on `req.headers`.
    next();
    return;
  }

  // SUPPORTED_PROTOCOL_VERSIONS is imported from the MCP SDK — always in sync with the SDK version
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    logger.warn(LogMessages.PROTOCOL_VERSION_UNSUPPORTED, truncateForLog(protocolVersion));
    res
      .status(HttpStatus.BAD_REQUEST)
      .json(
        createJsonRpcError(
          JsonRpcErrorCode.INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version: ${truncateForLog(protocolVersion)}. Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        ),
      );
    return;
  }

  next();
}
