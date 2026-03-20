/**
 * Custom Header Auth Middleware
 *
 * Extracts a token from a configurable request header (e.g. `X-API-Key`)
 * and validates it via a {@link TokenVerifier}. Sets `req.auth` on success,
 * matching the same contract as the SDK's bearer auth middleware.
 *
 * Use this when your auth model is not OAuth Bearer but a custom header
 * like `X-API-Key`, `X-Custom-Token`, etc.
 *
 * @module server/middleware/custom-header-auth
 */

import type { RequestHandler, Request, Response } from "express";

import type { TokenVerifier } from "../auth/types.js";
import { createJsonRpcError, HttpStatus, JsonRpcErrorCode } from "../../errors/index.js";
import { logger as baseLogger } from "../../logger/index.js";
import { logSecurityEvent } from "./logging.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "custom-header-auth";

const LogMessages = {
  CONFIGURED: "Custom header auth configured (header: %s, scopes: %s)",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating the custom header auth middleware.
 */
export interface CustomHeaderAuthOptions {
  /** Header name to extract the token from (e.g. `'X-API-Key'`) */
  readonly headerName: string;

  /** Token verifier to validate the extracted header value */
  readonly verifier: TokenVerifier;

  /**
   * Required scopes for all requests through this middleware.
   * Requests without ALL listed scopes are rejected with 403.
   */
  readonly requiredScopes?: readonly string[] | undefined;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a middleware that extracts a token from a custom header and
 * validates it via the provided {@link TokenVerifier}.
 *
 * On success, sets `req.auth` to the verified {@link AuthInfo} — same
 * contract as the SDK's bearer auth middleware.
 *
 * @param options - Custom header auth configuration
 * @returns Express middleware
 */
export function createCustomHeaderAuth(options: CustomHeaderAuthOptions): RequestHandler {
  const { headerName, verifier, requiredScopes } = options;

  const headerLower = headerName.toLowerCase();
  const scopeList = requiredScopes ? [...requiredScopes] : undefined;

  logger.info(LogMessages.CONFIGURED, headerName, scopeList?.join(", ") ?? "none");

  const middleware: RequestHandler = async (req: Request, res: Response, next) => {
    const token = req.headers[headerLower];

    if (!token || typeof token !== "string") {
      logSecurityEvent(`Custom header auth rejected: 401 (missing ${headerName})`, {
        method: req.method,
        path: req.path,
        statusCode: 401,
      });
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json(createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, `Missing ${headerName} header`));
      return;
    }

    try {
      const authInfo = await verifier.verifyAccessToken(token);

      // Scope enforcement
      if (scopeList && scopeList.length > 0) {
        const missing = scopeList.filter((s) => !authInfo.scopes.includes(s));
        if (missing.length > 0) {
          logSecurityEvent(`Custom header auth rejected: 403 (missing scopes: ${missing.join(", ")})`, {
            method: req.method,
            path: req.path,
            statusCode: 403,
          });
          res
            .status(HttpStatus.FORBIDDEN)
            .json(
              createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, `Missing required scopes: ${missing.join(", ")}`),
            );
          return;
        }
      }

      // Set req.auth — same contract as SDK's bearer auth
      // @express-api — Express Request augmented by SDK types
      (req as unknown as Record<string, unknown>).auth = authInfo;
      next();
    } catch {
      logSecurityEvent(`Custom header auth rejected: 401 (invalid token)`, {
        method: req.method,
        path: req.path,
        statusCode: 401,
      });
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json(createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, "Invalid or expired token"));
    }
  };

  return middleware;
}
