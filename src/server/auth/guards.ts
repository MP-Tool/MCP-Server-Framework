/**
 * Auth Guards
 *
 * Guard functions for tool handlers to enforce authentication and
 * authorization requirements. Two flavors:
 *
 * - **Throwing guards** (`require*`): Throw typed errors, use for mandatory checks.
 * - **Safe checks** (`has*`): Return booleans, use for conditional logic.
 *
 * @module server/auth/guards
 *
 * @example
 * ```typescript
 * import { requireAuth, requireScope, hasScope } from 'mcp-server-framework';
 *
 * const myTool = defineTool({
 *   name: 'deploy',
 *   input: z.object({ target: z.string() }),
 *   handler: async ({ context }) => {
 *     // Throwing guard — stops execution if not authenticated
 *     requireAuth(context.auth);
 *
 *     // Throwing guard — stops if scope missing
 *     requireScope(context.auth, 'deploy:write');
 *
 *     // Safe check — conditional logic
 *     if (hasScope(context.auth, 'deploy:admin')) {
 *       // admin-only path
 *     }
 *
 *     return text('deployed');
 *   },
 * });
 * ```
 */

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthenticationError, AuthorizationError } from "../../errors/categories/auth.js";

// ============================================================================
// Throwing Guards
// ============================================================================

/**
 * Require that the request is authenticated.
 *
 * @throws {@link AuthenticationError} if `authInfo` is `undefined`
 */
export function requireAuth(authInfo: AuthInfo | undefined): asserts authInfo is AuthInfo {
  if (!authInfo) {
    throw AuthenticationError.missingToken();
  }
}

/**
 * Require a specific scope on the authenticated token.
 *
 * @throws {@link AuthenticationError} if not authenticated
 * @throws {@link AuthorizationError} if scope is missing
 */
export function requireScope(authInfo: AuthInfo | undefined, scope: string): void {
  requireAuth(authInfo);
  if (!authInfo.scopes.includes(scope)) {
    throw AuthorizationError.insufficientScope([scope], authInfo.scopes);
  }
}

/**
 * Require all specified scopes on the authenticated token.
 *
 * @throws {@link AuthenticationError} if not authenticated
 * @throws {@link AuthorizationError} if any scope is missing
 */
export function requireScopes(authInfo: AuthInfo | undefined, scopes: string[]): void {
  requireAuth(authInfo);
  const missing = scopes.filter((s) => !authInfo.scopes.includes(s));
  if (missing.length > 0) {
    throw AuthorizationError.insufficientScope(scopes, authInfo.scopes);
  }
}

// ============================================================================
// Safe Checks (Boolean)
// ============================================================================

/**
 * Check if the token has a specific scope.
 * Returns `false` if not authenticated.
 */
export function hasScope(authInfo: AuthInfo | undefined, scope: string): boolean {
  return authInfo?.scopes.includes(scope) === true;
}

/**
 * Check if the token has all specified scopes.
 * Returns `false` if not authenticated.
 */
export function hasAllScopes(authInfo: AuthInfo | undefined, scopes: string[]): boolean {
  if (!authInfo) return false;
  return scopes.every((s) => authInfo.scopes.includes(s));
}

/**
 * Check if the token has at least one of the specified scopes.
 * Returns `false` if not authenticated.
 */
export function hasAnyScope(authInfo: AuthInfo | undefined, scopes: string[]): boolean {
  if (!authInfo) return false;
  return scopes.some((s) => authInfo.scopes.includes(s));
}
