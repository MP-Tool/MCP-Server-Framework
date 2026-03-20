/**
 * Auth Error Classes
 *
 * Errors related to authentication and authorization:
 * - AuthenticationError: Token validation failures, missing tokens (HTTP 401)
 * - AuthorizationError: Insufficient permissions or scopes (HTTP 403)
 *
 * @module errors/categories/auth
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ErrorCodes } from "../core/index.js";
import type { BaseErrorOptions } from "../core/index.js";

// ============================================================================
// Authentication Error (401)
// ============================================================================

/**
 * Error thrown when authentication fails.
 *
 * Maps to HTTP 401 Unauthorized — the request lacks valid credentials.
 *
 * @example
 * ```typescript
 * throw AuthenticationError.invalidToken('Token signature invalid');
 * throw AuthenticationError.tokenExpired();
 * throw AuthenticationError.missingToken();
 * ```
 */
export class AuthenticationError extends AppError {
  constructor(message: string, options: BaseErrorOptions = {}) {
    super(message, {
      code: ErrorCodes.UNAUTHORIZED,
      statusCode: 401,
      mcpCode: ErrorCode.InvalidRequest,
      ...options,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /** Token is invalid or malformed */
  static invalidToken(reason?: string): AuthenticationError {
    const message = reason ? `Invalid access token: ${reason}` : "Invalid access token";
    return new AuthenticationError(message, {
      recoveryHint: "Provide a valid Bearer token in the Authorization header",
    });
  }

  /** Token has expired */
  static tokenExpired(): AuthenticationError {
    return new AuthenticationError("Access token has expired", {
      recoveryHint: "Refresh the token or obtain a new one",
    });
  }

  /** No token provided in request */
  static missingToken(): AuthenticationError {
    return new AuthenticationError("Missing Bearer token", {
      recoveryHint: "Include an Authorization: Bearer <token> header",
    });
  }
}

// ============================================================================
// Authorization Error (403)
// ============================================================================

/**
 * Error thrown when authorization fails (authenticated but not permitted).
 *
 * Maps to HTTP 403 Forbidden — the request is authenticated but lacks
 * the required permissions or scopes.
 *
 * @example
 * ```typescript
 * throw AuthorizationError.insufficientScope(['mcp:write'], ['mcp:read']);
 * throw AuthorizationError.forbidden('Admin access required');
 * ```
 */
export class AuthorizationError extends AppError {
  /** Scopes that were required */
  readonly requiredScopes?: readonly string[] | undefined;

  /** Scopes that the token actually has */
  readonly actualScopes?: readonly string[] | undefined;

  constructor(
    message: string,
    options: BaseErrorOptions & {
      requiredScopes?: string[] | undefined;
      actualScopes?: string[] | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.FORBIDDEN,
      statusCode: 403,
      mcpCode: ErrorCode.InvalidRequest,
      ...options,
      context: {
        ...options.context,
        requiredScopes: options.requiredScopes,
        actualScopes: options.actualScopes,
      },
    });

    this.requiredScopes = options.requiredScopes ? Object.freeze([...options.requiredScopes]) : undefined;
    this.actualScopes = options.actualScopes ? Object.freeze([...options.actualScopes]) : undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /** Token lacks required scopes */
  static insufficientScope(required: readonly string[], actual: readonly string[]): AuthorizationError {
    return new AuthorizationError(`Insufficient scope: required [${required.join(", ")}], got [${actual.join(", ")}]`, {
      requiredScopes: [...required],
      actualScopes: [...actual],
      recoveryHint: `Token must include scopes: ${required.join(", ")}`,
    });
  }

  /** Generic forbidden — authenticated but not authorized */
  static forbidden(reason?: string): AuthorizationError {
    const message = reason ? `Access denied: ${reason}` : "Access denied";
    return new AuthorizationError(message);
  }
}
