/**
 * Bearer Auth Middleware
 *
 * Wraps the SDK's `requireBearerAuth()` middleware with framework-level
 * logging, error mapping, and support for both full OAuth providers and
 * custom token verifiers.
 *
 * Follows the factory pattern established by `createRateLimiter()` and
 * `dnsRebindingProtection`.
 *
 * @module server/middleware/bearer-auth
 */

import type { RequestHandler } from "express";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import type { AuthProvider } from "../auth/types.js";
import { isFullOAuthProvider } from "../auth/types.js";
import { logger as baseLogger } from "../../logger/index.js";
import { logSecurityEvent } from "./logging.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "bearer-auth";

const LogMessages = {
  CONFIGURED_OAUTH: "Bearer auth configured (full OAuth provider, scopes: %s)",
  CONFIGURED_VERIFIER: "Bearer auth configured (token verifier, scopes: %s)",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating the bearer auth middleware.
 */
export interface BearerAuthOptions {
  /** Authentication provider (full OAuth or token verifier) */
  readonly provider: AuthProvider;

  /**
   * Required OAuth scopes for all requests through this middleware.
   * Requests without ALL listed scopes are rejected with 403.
   */
  readonly requiredScopes?: readonly string[] | undefined;

  /**
   * Protected Resource Metadata URL (RFC 9728).
   * Included in `WWW-Authenticate` headers for 401 responses.
   */
  readonly resourceMetadataUrl?: string | undefined;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a bearer auth middleware that validates access tokens.
 *
 * Delegates to the SDK's `requireBearerAuth()` for actual token validation.
 * Supports both full OAuth providers and custom token verifiers via the
 * {@link AuthProvider} union type.
 *
 * @param options - Bearer auth configuration
 * @returns Express middleware that sets `req.auth` on success
 */
export function createBearerAuth(options: BearerAuthOptions): RequestHandler {
  const { provider, requiredScopes, resourceMetadataUrl } = options;

  // SDK's requireBearerAuth accepts:
  // - Full OAuthServerProvider — used as-is
  // - { verifyAccessToken } — for token-only verification
  const verifier = isFullOAuthProvider(provider)
    ? provider
    : { verifyAccessToken: provider.verifyAccessToken.bind(provider) };

  const scopeList = requiredScopes ? [...requiredScopes] : undefined;

  if (isFullOAuthProvider(provider)) {
    logger.info(LogMessages.CONFIGURED_OAUTH, scopeList?.join(", ") ?? "none");
  } else {
    logger.info(LogMessages.CONFIGURED_VERIFIER, scopeList?.join(", ") ?? "none");
  }

  const sdkMiddleware = requireBearerAuth({
    verifier,
    ...(scopeList && scopeList.length > 0 && { requiredScopes: scopeList }),
    ...(resourceMetadataUrl && { resourceMetadataUrl }),
  });

  // Wrap SDK middleware with security logging for failures
  const middleware: RequestHandler = (req, res, next) => {
    // Log auth failures after response is sent
    res.on("finish", () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        logSecurityEvent(`Bearer auth rejected: ${res.statusCode}`, {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
        });
      }
    });

    sdkMiddleware(req, res, next);
  };

  return middleware;
}
