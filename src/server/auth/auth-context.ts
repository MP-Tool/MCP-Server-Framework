/**
 * Auth Context Types
 *
 * Authentication and authorization context for MCP sessions.
 * Aligned with the SDK's `AuthInfo` type from `@modelcontextprotocol/sdk`.
 *
 * The SDK provides `AuthInfo` (token, clientId, scopes, expiresAt) through
 * `RequestHandlerExtra.authInfo` in tool handlers. This module wraps it with
 * framework-level auth metadata prepared for future permission systems.
 *
 * @module server/auth/auth-context
 */

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// Re-export SDK type for convenience
export type { AuthInfo };

// ============================================================================
// Auth Context
// ============================================================================

/**
 * Authentication context for a session.
 *
 * Wraps the SDK's `AuthInfo` (from OAuth/Bearer middleware) and adds
 * framework-level auth metadata for future user/permission systems.
 *
 * When no auth middleware is configured, sessions use `ANONYMOUS_AUTH`.
 */
export interface AuthContext {
  /** Whether the session is authenticated */
  readonly isAuthenticated: boolean;

  /** SDK auth info from transport (populated by OAuth middleware via `req.auth`) */
  readonly sdkAuthInfo?: AuthInfo;

  /** Resolved user identity (future: mapped from sdkAuthInfo.clientId or custom resolver) */
  readonly userId?: string;

  /** Framework permission scopes (future: role-based or mapped from sdkAuthInfo.scopes) */
  readonly permissions?: readonly string[];

  /** When authentication was validated */
  readonly authenticatedAt?: Date;

  /** Consumer-provided extra data (populated via `onAuthenticated` hook) */
  readonly extra?: Record<string, unknown> | undefined;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Anonymous auth context (default for unauthenticated sessions).
 */
export const ANONYMOUS_AUTH: AuthContext = Object.freeze({
  isAuthenticated: false,
});

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates an authenticated auth context from SDK AuthInfo.
 *
 * @public Available for consumers implementing custom auth strategies.
 * Part of the auth extension point.
 *
 * @param sdkAuthInfo - SDK auth info from transport middleware
 * @param userId - Optional resolved user identity
 * @param permissions - Optional framework-level permissions
 */
export function createAuthContext(
  sdkAuthInfo: AuthInfo,
  userId?: string,
  permissions?: string[],
  extra?: Record<string, unknown>,
): AuthContext {
  return Object.freeze({
    isAuthenticated: true,
    sdkAuthInfo,
    userId: userId ?? sdkAuthInfo.clientId,
    permissions: permissions ? Object.freeze([...permissions]) : Object.freeze([...sdkAuthInfo.scopes]),
    authenticatedAt: new Date(),
    extra: extra ? Object.freeze({ ...extra }) : undefined,
  });
}
