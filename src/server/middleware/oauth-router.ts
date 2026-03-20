/**
 * OAuth Router Middleware
 *
 * Wraps the SDK's `mcpAuthRouter()` to mount OAuth 2.1 endpoints
 * when a full OAuth provider is configured.
 *
 * Routes mounted:
 * - `GET /authorize` — Authorization endpoint
 * - `POST /token` — Token endpoint
 * - `POST /register` — Dynamic client registration
 * - `POST /revoke` — Token revocation
 * - `GET /.well-known/oauth-authorization-server` — Authorization Server Metadata (RFC 8414)
 * - `GET /.well-known/oauth-protected-resource` — Protected Resource Metadata (RFC 9728)
 *
 * Only created when the provider is a full `OAuthServerProvider`
 * (detected via {@link isFullOAuthProvider}).
 *
 * @module server/middleware/oauth-router
 */

import type { RequestHandler } from "express";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter, type AuthRouterOptions } from "@modelcontextprotocol/sdk/server/auth/router.js";

import { logger as baseLogger } from "../../logger/index.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "oauth-router";

const LogMessages = {
  MOUNTED: "OAuth router mounted (issuer: %s)",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating the OAuth router.
 */
export interface OAuthRouterOptions {
  /** Full OAuth server provider (must have `clientsStore`) */
  readonly provider: OAuthServerProvider;

  /**
   * OAuth issuer URL (Authorization Server identifier).
   * Required by the MCP SDK for Authorization Server Metadata (RFC 8414).
   */
  readonly issuerUrl: URL;

  /**
   * Scopes supported by this authorization server.
   * Advertised in the Authorization Server Metadata document.
   */
  readonly scopesSupported?: readonly string[];
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an Express router with OAuth 2.1 endpoints.
 *
 * Delegates to the SDK's `mcpAuthRouter()` for the actual endpoint
 * implementation. The router handles authorization, token exchange,
 * client registration, and discovery metadata.
 *
 * @param options - OAuth router configuration
 * @returns Express request handler (router) with OAuth endpoints
 */
export function createOAuthRouter(options: OAuthRouterOptions): RequestHandler {
  const { provider, issuerUrl, scopesSupported } = options;

  const routerOptions: AuthRouterOptions = {
    provider,
    issuerUrl,
    ...(scopesSupported && { scopesSupported: [...scopesSupported] }),
  };

  logger.info(LogMessages.MOUNTED, issuerUrl.toString());

  return mcpAuthRouter(routerOptions);
}
