/**
 * Auth Types
 *
 * Core type definitions for the framework's authentication and authorization system.
 * Provides the {@link AuthProvider} union type, {@link TokenVerifier} interface,
 * and {@link AuthOptions} configuration.
 *
 * The SDK provides {@link OAuthServerProvider} for full OAuth flows and
 * {@link OAuthTokenVerifier} for token-only verification. This module wraps
 * these into a unified {@link AuthProvider} type for framework use.
 *
 * @module server/auth/types
 */

import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandler } from "express";

// Re-export SDK types for consumer convenience
export type { OAuthServerProvider, AuthInfo };

// ============================================================================
// Token Verifier (Extension Point)
// ============================================================================

/**
 * Minimal interface for custom token verification.
 *
 * Implement this to integrate non-OAuth auth (API keys, JWTs, custom tokens)
 * into the framework's auth pipeline. Structurally compatible with the SDK's
 * `OAuthTokenVerifier`.
 *
 * @example
 * ```typescript
 * const apiKeyVerifier: TokenVerifier = {
 *   verifyAccessToken: async (token) => {
 *     const user = await db.users.findByApiKey(token);
 *     if (!user) throw new Error('Invalid API key');
 *     return { token, clientId: user.id, scopes: user.permissions };
 *   },
 * };
 * ```
 */
export interface TokenVerifier {
  /**
   * Verify an access token and return auth information.
   *
   * @param token - The bearer token from the Authorization header
   * @returns Auth info with clientId, scopes, and optional expiry
   * @throws If the token is invalid, expired, or revoked
   */
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

// ============================================================================
// Auth Provider (Union Type)
// ============================================================================

/**
 * Authentication provider — either a full OAuth server or a token verifier.
 *
 * - **`OAuthServerProvider`**: Full OAuth 2.1 flow with authorization,
 *   token exchange, client registration, and token revocation.
 *   Enables `mcpAuthRouter()` for `/authorize`, `/token`, etc.
 *
 * - **`TokenVerifier`**: Token-only verification for custom auth.
 *   Bearer tokens are validated but no OAuth endpoints are mounted.
 *
 * Use {@link isFullOAuthProvider} to discriminate at runtime.
 */
export type AuthProvider = OAuthServerProvider | TokenVerifier;

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to distinguish a full OAuth provider from a token verifier.
 *
 * Full OAuth providers have a `clientsStore` property (per SDK's
 * `OAuthServerProvider` interface) — token verifiers do not.
 *
 * @param provider - The auth provider to check
 * @returns `true` if the provider offers full OAuth capabilities
 */
export function isFullOAuthProvider(provider: AuthProvider): provider is OAuthServerProvider {
  return "clientsStore" in provider;
}

// ============================================================================
// Consumer Extension Type
// ============================================================================

/**
 * Extra data attached to the auth context by the consumer.
 *
 * Populated via the `onAuthenticated` hook, this allows consumers to
 * map OAuth `clientId`/`scopes` to their own user model, permissions,
 * or any additional data needed in tool handlers.
 *
 * @example
 * ```typescript
 * auth: {
 *   onAuthenticated: async (authInfo) => ({
 *     userId: await resolveUser(authInfo.clientId),
 *     role: 'admin',
 *     permissions: ['read', 'write', 'deploy'],
 *   }),
 * }
 * ```
 */
export type AuthenticatedExtra = Record<string, unknown>;

// ============================================================================
// Auth Options
// ============================================================================

/**
 * Authentication configuration for the server.
 *
 * Passed via `ServerOptions.auth` or `McpServerBuilder.withAuthOptions()`.
 *
 * @example External OAuth provider (e.g. GitHub via SDK's ProxyOAuthServerProvider)
 * ```typescript
 * import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
 *
 * const github = new ProxyOAuthServerProvider({ endpoints, verifyAccessToken, getClient });
 * createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   auth: {
 *     provider: github,
 *     issuerUrl: new URL('https://github.com'),
 *     requiredScopes: ['read:user'],
 *   },
 * });
 * ```
 *
 * @example Custom header auth (e.g. X-API-Key)
 * ```typescript
 * createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   auth: {
 *     provider: myApiKeyVerifier,
 *     headerName: 'X-API-Key',
 *   },
 * });
 * ```
 *
 * @example Token verification only (Bearer)
 * ```typescript
 * createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   auth: {
 *     provider: myJwtVerifier,
 *   },
 * });
 * ```
 */
export interface AuthOptions {
  /** Authentication provider (full OAuth or token verifier) */
  readonly provider: AuthProvider;

  /**
   * Global required scopes for the `/mcp` endpoint.
   *
   * All requests to `/mcp` must have tokens with these scopes.
   * Per-capability scopes can be set via `requiredScopes` on tool, resource, and prompt definitions.
   */
  readonly requiredScopes?: string[];

  /**
   * When `true`, capability list handlers (`tools/list`, `resources/list`, `prompts/list`)
   * filter out entries whose `requiredScopes` are not satisfied by the requesting user's token.
   *
   * **Default: `false`** (spec-konform — all capabilities are listed regardless of scopes).
   * Enforcement always happens at execution time (403), independent of this setting.
   *
   * Enable this for UIs that should only show actionable items to users.
   */
  readonly scopeFilterCapabilities?: boolean;

  /**
   * OAuth issuer URL (Authorization Server identifier).
   *
   * Required for full OAuth providers. Used as the `issuer` in
   * OAuth Authorization Server Metadata (RFC 8414).
   * Must use HTTPS scheme and have no query or fragment components.
   */
  readonly issuerUrl?: URL;

  /**
   * Protected Resource Metadata URL (RFC 9728).
   *
   * Included in `WWW-Authenticate` headers for 401 responses,
   * allowing clients to discover the authorization server.
   */
  readonly resourceMetadataUrl?: string;

  /**
   * Custom header name for token extraction.
   *
   * When set, the framework extracts the token from this header instead of
   * the standard `Authorization: Bearer <token>` header. Only allowed with
   * {@link TokenVerifier} providers (not with full OAuth providers).
   *
   * @example `'X-API-Key'` — extracts the value of the `X-API-Key` header
   */
  readonly headerName?: string;

  /**
   * Hook called after successful token verification.
   *
   * Use this to map OAuth `clientId`/`scopes` to your own user model.
   * The returned data is available in tool handlers via `context.auth.extra`.
   *
   * @param authInfo - Verified auth info from the token
   * @returns Extra data for `context.auth.extra`, or `undefined`
   */
  readonly onAuthenticated?: (authInfo: AuthInfo) => Promise<AuthenticatedExtra | undefined>;

  /**
   * Express handler for the OAuth callback route (`GET /callback`).
   *
   * Required for OAuth providers that use server-side callbacks (e.g.,
   * GitHub, Google) where the upstream provider redirects back to the
   * MCP server rather than directly to the MCP client.
   *
   * The handler receives the authorization code from the upstream provider
   * and redirects the user to the MCP client's redirect_uri.
   *
   * Only effective when a full OAuth provider is configured.
   */
  readonly callbackHandler?: RequestHandler;
}
