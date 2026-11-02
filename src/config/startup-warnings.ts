/**
 * Startup Warning Buffer
 *
 * Collects warnings and errors that occur during config loading, before
 * the framework logger is initialized. After logger initialization,
 * the buffers are flushed to the real logger.
 *
 * This solves the chicken-and-egg problem where config loading
 * (which runs before the logger) may produce warnings (e.g.,
 * unknown config file keys, wildcard origins in production)
 * that should appear in structured logs, not just on stderr.
 *
 * If `flush()` is never called (e.g., server crashes before
 * logger init), warnings were already emitted to `console.warn`
 * as a fallback when they were buffered.
 *
 * @module config/startup-warnings
 */

// ============================================================================
// Buffer
// ============================================================================

/** Buffered warning messages */
const warnings: string[] = [];

/** Buffered error messages */
const errors: string[] = [];

/**
 * Buffer a startup warning for later logger replay.
 *
 * The message is also immediately written to `console.warn` as a
 * fallback — if the server never reaches logger initialization
 * (crash, validation error), the warning is still visible on stderr.
 *
 * @param message - Warning message to buffer and emit
 */
export function addStartupWarning(message: string): void {
  console.warn(message);
  warnings.push(message);
}

/**
 * Flush all buffered warnings through the provided logger function.
 *
 * Typically called once during server startup after the logger is
 * configured. Clears the buffer after flushing.
 *
 * @param logFn - Logger function to replay warnings through (e.g., `logger.warn`)
 */
export function flushStartupWarnings(logFn: (message: string) => void): void {
  for (const message of warnings) {
    logFn(message);
  }
  warnings.length = 0;
}

/**
 * Buffer a startup error the server continues after, for later logger replay. Also written
 * to `console.error` right away, for the same reason as {@link addStartupWarning}.
 *
 * @param message - Error message to buffer and emit
 */
export function addStartupError(message: string): void {
  console.error(message);
  errors.push(message);
}

/**
 * Flush all buffered errors through the provided logger function, then clear the buffer.
 *
 * @param logFn - Logger function to replay errors through (e.g., `logger.error`)
 */
export function flushStartupErrors(logFn: (message: string) => void): void {
  for (const message of errors) {
    logFn(message);
  }
  errors.length = 0;
}
