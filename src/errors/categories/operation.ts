/**
 * Operation Error Classes
 *
 * Errors related to operation execution:
 * - OperationError: Generic operation failures
 * - OperationCancelledError: Request cancellation
 *
 * @module errors/categories/operation
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ErrorCodes } from "../core/index.js";
import type { BaseErrorOptions } from "../core/index.js";

// ============================================================================
// Operation Error
// ============================================================================

/**
 * Error for failed operations.
 *
 * Use this for operations that fail due to business logic
 * or external factors (not validation or internal errors).
 *
 * @example
 * ```typescript
 * throw new OperationError('Failed to process request', {
 *   operation: 'processData',
 *   context: { dataId: '123' }
 * });
 *
 * // Using factory methods
 * throw OperationError.failed('processData', 'timeout exceeded');
 * ```
 */
export class OperationError extends AppError {
  /** The operation that failed */
  readonly operation?: string | undefined;

  constructor(
    message: string,
    options: Omit<BaseErrorOptions, "code"> & {
      operation?: string | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.OPERATION_ERROR,
      statusCode: options.statusCode || 500,
      mcpCode: ErrorCode.InternalError,
      cause: options.cause,
      recoveryHint: options.recoveryHint,
      context: {
        ...options.context,
        operation: options.operation,
      },
    });

    this.operation = options.operation;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an OperationError for a failed operation.
   */
  static failed(operation: string, reason?: string): OperationError {
    const message = reason ? `Operation '${operation}' failed: ${reason}` : `Operation '${operation}' failed`;

    return new OperationError(message, {
      operation,
      recoveryHint: reason ? `Operation failed: ${reason}. Please try again.` : "Please try the operation again.",
    });
  }

  /**
   * Create an OperationError for a timeout.
   */
  static timeout(operation: string, timeoutMs: number): OperationError {
    return new OperationError(`Operation '${operation}' timed out after ${timeoutMs}ms`, {
      operation,
      statusCode: 504,
      context: { timeoutMs },
      recoveryHint: `Operation '${operation}' timed out after ${timeoutMs}ms. Try again or increase timeout.`,
    });
  }

  /**
   * Create an OperationError for an unavailable operation.
   */
  static unavailable(operation: string): OperationError {
    return new OperationError(`Operation '${operation}' is currently unavailable`, {
      operation,
      statusCode: 503,
      recoveryHint: `Operation '${operation}' is currently unavailable. Please try again later.`,
    });
  }
}

// ============================================================================
// Operation Cancelled Error
// ============================================================================

/**
 * Error thrown when an operation is cancelled.
 *
 * Used primarily with AbortSignal/AbortController for
 * cancellable operations.
 *
 * @example
 * ```typescript
 * signal.addEventListener('abort', () => {
 *   throw new OperationCancelledError('User cancelled the request', requestId);
 * });
 *
 * // Check if error is cancellation
 * if (error instanceof OperationCancelledError) {
 *   // Handle gracefully
 * }
 * ```
 */
export class OperationCancelledError extends AppError {
  /** The ID of the cancelled request */
  readonly requestId?: string | number | undefined;

  /** The reason for cancellation */
  readonly cancelReason?: string | undefined;

  constructor(
    message: string,
    requestId?: string | number,
    options: Omit<BaseErrorOptions, "code"> & {
      cancelReason?: string | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.OPERATION_CANCELLED,
      statusCode: 499, // Client Closed Request
      mcpCode: ErrorCode.InternalError,
      cause: options.cause,
      recoveryHint: options.recoveryHint || "The operation was cancelled. You may retry if needed.",
      context: {
        ...options.context,
        requestId,
        cancelReason: options.cancelReason,
      },
    });

    this.requestId = requestId;
    this.cancelReason = options.cancelReason;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create from a cancelled request.
   */
  static fromRequest(requestId: string | number, reason?: string): OperationCancelledError {
    const message = reason ? `Request ${requestId} was cancelled: ${reason}` : `Request ${requestId} was cancelled`;

    return new OperationCancelledError(message, requestId, {
      cancelReason: reason,
    });
  }

  /**
   * Create from an AbortSignal.
   */
  static fromAbortSignal(signal: AbortSignal, requestId?: string | number): OperationCancelledError {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason || "Aborted");

    return new OperationCancelledError(`Operation aborted: ${reason}`, requestId, {
      cancelReason: reason,
      cause: signal.reason instanceof Error ? signal.reason : undefined,
    });
  }
}
