/**
 * Scope Enforcement for SDK Bindings
 *
 * Centralizes RBAC scope checking used by tool, resource, and prompt registries.
 * This is the internal enforcement layer — for consumer-facing guards,
 * see `server/auth/guards.ts` (requireAuth, requireScope, hasScope).
 *
 * @module mcp/capabilities/registry/scope-enforcement
 * @internal
 */

import { AuthorizationError } from "../../../errors/index.js";
import { auditActor, logAuditEvent } from "../../../logger/audit/index.js";
import type { Logger } from "../../../logger/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal auth info shape from SDK's `extra.authInfo`.
 * Kept intentionally loose to match all SDK callback signatures.
 * @internal
 */
export interface SdkAuthInfo {
  readonly scopes?: readonly string[];
  readonly clientId?: string;
  readonly extra?: Record<string, unknown>;
}

/**
 * The request a scope check runs for, from the SDK's `extra`. For the audit record.
 * @internal
 */
export interface ScopeCheckRequest {
  readonly sessionId?: string | undefined;
  readonly requestId?: string | number | undefined;
}

// ============================================================================
// Constants
// ============================================================================

const AUTH_SCOPE_DENIED = "%s [%s] requires scopes [%s] but token has [%s]";

// ============================================================================
// Enforcement
// ============================================================================

/**
 * The auth info a scope check runs against: the request's own, or — for an anonymous
 * request — the server's restricted anonymous scope set, so the same RBAC gates anonymous
 * traffic without fabricating an identity. `undefined` (no auth and no anonymous scope set)
 * leaves enforcement off, as on stdio or an unrestricted server.
 *
 * @internal
 */
export function scopeSubject(
  authInfo: SdkAuthInfo | undefined,
  anonymousScopes: readonly string[] | undefined,
): SdkAuthInfo | undefined {
  return authInfo ?? (anonymousScopes ? { scopes: anonymousScopes } : undefined);
}

/**
 * Checks that all `requiredScopes` are present in the token's scopes.
 * Throws {@link AuthorizationError}, logs a warning and writes a `permission.denied` audit
 * record if scopes are insufficient: a refused call reaches no handler and no `tool.call` record.
 *
 * No-op when:
 * - `requiredScopes` is undefined or empty
 * - `authInfo` is undefined (no auth middleware active)
 *
 * @param requiredScopes - Scopes required by the definition (AND logic)
 * @param authInfo - Auth info from SDK `extra.authInfo`
 * @param capabilityType - Label for log messages (e.g. 'Tool', 'Resource', 'Prompt')
 * @param capabilityName - Name/URI of the capability for log context
 * @param logger - Logger instance for warning output
 * @param request - The request being checked, for the audit record
 *
 * @throws {@link AuthorizationError} when required scopes are not satisfied
 * @internal
 */
export function enforceScopeOrThrow(
  requiredScopes: readonly string[] | undefined,
  authInfo: SdkAuthInfo | undefined,
  capabilityType: string,
  capabilityName: string,
  logger: Logger,
  request: ScopeCheckRequest,
): void {
  if (!requiredScopes || requiredScopes.length === 0 || !authInfo) {
    return;
  }

  const tokenScopes = authInfo.scopes ?? [];
  const missing = requiredScopes.filter((s) => !tokenScopes.includes(s));

  if (missing.length > 0) {
    logger.warn(AUTH_SCOPE_DENIED, capabilityType, capabilityName, requiredScopes.join(","), tokenScopes.join(","));
    logAuditEvent({
      category: "permission",
      action: "permission.denied",
      outcome: "denied",
      target: capabilityName,
      ...(request.requestId !== undefined && { requestId: String(request.requestId) }),
      actor: auditActor(request.sessionId, { authInfo, extra: authInfo.extra }),
      detail: { capability: capabilityType, requiredScopes, missingScopes: missing },
    });
    throw AuthorizationError.insufficientScope(requiredScopes, tokenScopes);
  }
}

// ============================================================================
// List Filtering
// ============================================================================

/**
 * Checks if all required scopes are present in the token's scopes.
 * Used by scope-filtered list handlers to decide visibility.
 *
 * @param required - Scopes required by the definition (AND logic)
 * @param tokenScopes - Scopes present on the token
 * @returns `true` if all required scopes are present
 * @internal
 */
export function hasAllRequiredScopes(required: readonly string[], tokenScopes: readonly string[]): boolean {
  return required.every((s) => tokenScopes.includes(s));
}
