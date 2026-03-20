/**
 * Session Error
 *
 * Error for MCP session management issues (not found, expired, limit reached).
 *
 * @module errors/categories/session
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ErrorCodes, HttpStatus } from "../core/index.js";
import type { BaseErrorOptions } from "../core/index.js";

// ============================================================================
// Session Error
// ============================================================================

/**
 * Error thrown for session management issues.
 *
 * @example
 * ```typescript
 * throw SessionError.required();
 * throw SessionError.sessionNotFound('sess-123');
 * ```
 */
export class SessionError extends AppError {
  /** The session ID if applicable */
  readonly sessionId?: string | undefined;

  constructor(
    message: string,
    options: Omit<BaseErrorOptions, "code"> & {
      sessionId?: string | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.INVALID_REQUEST,
      statusCode: options.statusCode ?? HttpStatus.BAD_REQUEST,
      mcpCode: ErrorCode.InvalidRequest,
      cause: options.cause,
      context: {
        ...options.context,
        sessionId: options.sessionId,
      },
      recoveryHint: options.recoveryHint,
    });

    this.sessionId = options.sessionId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an error for missing session ID.
   */
  static required(): SessionError {
    return new SessionError("Mcp-Session-Id header required", {
      recoveryHint: "Include the Mcp-Session-Id header in your request.",
    });
  }

  /**
   * Create an error for session not found (with ID).
   */
  static sessionNotFound(sessionId: string): SessionError {
    return new SessionError(`Session '${sessionId}' not found`, {
      sessionId,
      recoveryHint: "Start a new session by connecting to the SSE endpoint.",
    });
  }

  /**
   * Create an error for expired session.
   */
  static expired(): SessionError {
    return new SessionError("Session has expired. Please re-initialize.", {
      recoveryHint: "Your session has expired. Reconnect to establish a new session.",
    });
  }

  /**
   * Create an error for expired session (with ID).
   */
  static sessionExpired(sessionId: string): SessionError {
    return new SessionError(`Session '${sessionId}' has expired`, {
      sessionId,
      recoveryHint: "Your session has expired. Reconnect to establish a new session.",
    });
  }

  /**
   * Create an error for session limit reached.
   */
  static sessionLimitReached(maxSessions: number): SessionError {
    return new SessionError(`Session limit reached: maximum ${maxSessions} sessions allowed`, {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      context: { maxSessions },
      recoveryHint: "Wait a moment and try again, or close unused sessions.",
    });
  }

  /**
   * Create an error for invalid session state.
   */
  static invalidState(sessionId: string, currentState: string, expectedState: string): SessionError {
    return new SessionError(
      `Session '${sessionId}' is in invalid state '${currentState}', expected '${expectedState}'`,
      {
        sessionId,
        context: { currentState, expectedState },
        recoveryHint: `Session is in '${currentState}' state but needs to be '${expectedState}'.`,
      },
    );
  }
}
