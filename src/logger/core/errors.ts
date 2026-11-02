/**
 * Logger Error Classes Module
 *
 * Provides typed error classes for the logging system. Standalone
 * implementation with no dependencies on framework error classes
 * or external packages — the logger module must remain dependency-free.
 *
 * @module logger/core/errors
 */

// ============================================================================
// Logger Error Codes
// ============================================================================

/**
 * Logger-specific error codes.
 */
export const LoggerErrorCode = {
  /** Generic logger error */
  LOGGER_ERROR: "LOGGER_ERROR",
  /** Context depth exceeded */
  CONTEXT_DEPTH_EXCEEDED: "CONTEXT_DEPTH_EXCEEDED",
  /** Scrubbing operation failed */
  SCRUBBER_ERROR: "SCRUBBER_ERROR",
} as const;

export type LoggerErrorCodeType = (typeof LoggerErrorCode)[keyof typeof LoggerErrorCode];

/** Options accepted by all logger error constructors. */
interface LoggerErrorOptions {
  code?: LoggerErrorCodeType | undefined;
  cause?: Error | undefined;
  context?: Record<string, unknown> | undefined;
}

// ============================================================================
// Base Logger Error
// ============================================================================

/**
 * Base error class for all logger-related errors.
 *
 * Standalone implementation extending native `Error` — no dependency on
 * the framework's `AppError` hierarchy. This ensures the logger module
 * has zero cross-module imports.
 *
 * @example
 * ```typescript
 * throw new LoggerError('Failed to initialize logger', {
 *   code: LoggerErrorCode.LOGGER_ERROR,
 *   cause: originalError,
 *   context: { format: 'json' }
 * });
 * ```
 */
export class LoggerError extends Error {
  /** Logger-specific error code. */
  readonly code: LoggerErrorCodeType;

  /** Additional context for debugging. */
  readonly context?: Record<string, unknown> | undefined;

  override readonly cause?: Error | undefined;

  constructor(message: string, options: LoggerErrorOptions = {}) {
    super(message);
    this.name = "LoggerError";
    this.code = options.code ?? LoggerErrorCode.LOGGER_ERROR;
    this.cause = options.cause;
    this.context = options.context;
  }

  /**
   * Check if an error is a LoggerError instance.
   */
  static isLoggerError(error: unknown): error is LoggerError {
    return error instanceof LoggerError;
  }
}

/**
 * Error thrown when secret scrubbing fails.
 */
export class ScrubberError extends LoggerError {
  constructor(
    message: string,
    options: {
      cause?: Error | undefined;
      context?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(message, {
      code: LoggerErrorCode.SCRUBBER_ERROR,
      cause: options.cause,
      context: options.context,
    });
    this.name = "ScrubberError";
  }
}
