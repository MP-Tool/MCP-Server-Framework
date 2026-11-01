/**
 * Content-Encoding rejection middleware
 *
 * The body parsers (the framework's own json/urlencoded parsers and the ones inside the
 * SDK's OAuth router) transparently inflate gzip, deflate and br request bodies — and they
 * run ahead of DNS-rebinding protection, rate limiting and auth. That hands the runtime's
 * decompressors untrusted input from unauthenticated clients (Node2Shell, CVE-2026-111497:
 * out-of-bounds write in the Brotli decoder bundled with Node.js). No MCP or OAuth client
 * compresses its request bodies, so the server does not accept them at all.
 *
 * @module server/middleware/content-encoding
 */

import type { Request, Response, NextFunction } from "express";
import { createJsonRpcError, HttpStatus, JsonRpcErrorCode, TransportErrorMessage } from "../../errors/index.js";
import { logSecurityEvent, truncateForLog } from "./logging.js";

/** The only content coding accepted on request bodies. */
const IDENTITY_CODING = "identity";

/**
 * Rejects any request whose `Content-Encoding` names a coding other than `identity`
 * with `415 Unsupported Media Type` and `Accept-Encoding: identity` (RFC 9110 §15.5.16).
 *
 * Must be mounted ahead of every body parser, so no compressed body is ever inflated.
 */
export function rejectEncodedRequestBodies(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers["content-encoding"];
  if (header === undefined) {
    next();
    return;
  }

  const codings = header
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "");
  if (codings.every((coding) => coding === IDENTITY_CODING)) {
    next();
    return;
  }

  logSecurityEvent(`Encoded request body rejected: Content-Encoding=${truncateForLog(header)}`);
  res
    .status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
    .set("Accept-Encoding", IDENTITY_CODING)
    .json(createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, TransportErrorMessage.UNSUPPORTED_CONTENT_ENCODING));
}
