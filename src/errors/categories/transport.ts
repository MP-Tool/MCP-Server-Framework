/**
 * Transport Error
 *
 * Error for MCP transport layer issues (connection, binding, rate limiting).
 *
 * @module errors/categories/transport
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ErrorCodes, HttpStatus } from "../core/index.js";
import type { BaseErrorOptions } from "../core/index.js";

// ============================================================================
// Transport Error
// ============================================================================

/**
 * Error thrown for transport layer issues.
 *
 * @example
 * ```typescript
 * throw TransportError.closed();
 * throw TransportError.connectionFailed('timeout');
 * ```
 */
export class TransportError extends AppError {
  /** The transport type */
  readonly transportType?: "http" | "sse" | "stdio" | undefined;

  constructor(
    message: string,
    options: Omit<BaseErrorOptions, "code"> & {
      transportType?: "http" | "sse" | "stdio" | undefined;
    } = {},
  ) {
    super(message, {
      code: ErrorCodes.SERVICE_UNAVAILABLE,
      statusCode: options.statusCode ?? HttpStatus.SERVICE_UNAVAILABLE,
      mcpCode: ErrorCode.InternalError,
      cause: options.cause,
      recoveryHint: options.recoveryHint,
      context: {
        ...options.context,
        transportType: options.transportType,
      },
    });

    this.transportType = options.transportType;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an error for closed transport.
   */
  static closed(): TransportError {
    return new TransportError("Transport is closed", {
      recoveryHint: "The transport connection was closed. Reconnect to continue.",
    });
  }

  /**
   * Create an error for transport not started.
   */
  static notStarted(): TransportError {
    return new TransportError("Transport not started", {
      recoveryHint: "Ensure the transport is properly started before sending messages.",
    });
  }

  /**
   * Create an error for unsupported transport type.
   */
  static unsupported(transport: string): TransportError {
    return new TransportError(`Unsupported transport type: ${transport}`, {
      recoveryHint: "Use a supported transport type: stdio or http.",
    });
  }

  /**
   * Create an error for connection failure.
   */
  static connectionFailed(reason: string): TransportError {
    return new TransportError(`Connection failed: ${reason}`, {
      statusCode: HttpStatus.BAD_GATEWAY,
      recoveryHint: `Connection failed: ${reason}. Check network connectivity and try again.`,
    });
  }

  /**
   * Create an error for connection closed.
   */
  static connectionClosed(reason?: string): TransportError {
    const message = reason ? `Connection closed: ${reason}` : "Connection closed";

    return new TransportError(message, {
      recoveryHint: "The connection was closed. Reconnect to continue.",
    });
  }

  /**
   * Create an error for invalid header.
   */
  static invalidHeader(header: string, reason: string): TransportError {
    return new TransportError(`Invalid header '${header}': ${reason}`, {
      statusCode: HttpStatus.BAD_REQUEST,
      context: { header, reason },
      recoveryHint: `Check the '${header}' header value.`,
    });
  }

  /**
   * Create an error for protocol mismatch.
   */
  static protocolMismatch(expected: string, received: string): TransportError {
    return new TransportError(`Protocol mismatch: expected '${expected}', received '${received}'`, {
      statusCode: HttpStatus.BAD_REQUEST,
      context: { expected, received },
      recoveryHint: `Use protocol version '${expected}'.`,
    });
  }

  /**
   * Create an error for rate limiting.
   */
  static rateLimited(retryAfterSeconds?: number): TransportError {
    const message = retryAfterSeconds
      ? `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds`
      : "Rate limit exceeded";

    return new TransportError(message, {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      context: retryAfterSeconds ? { retryAfterSeconds } : undefined,
      recoveryHint: retryAfterSeconds
        ? `Wait ${retryAfterSeconds} seconds before retrying.`
        : "Wait a moment before retrying.",
    });
  }

  /**
   * Create an error for DNS rebinding attack.
   */
  static dnsRebinding(host: string): TransportError {
    return new TransportError(`DNS rebinding attack detected from host '${host}'`, {
      statusCode: HttpStatus.FORBIDDEN,
      context: { host },
      recoveryHint: "Access denied for security reasons.",
    });
  }

  /**
   * Create an error for port already in use (EADDRINUSE).
   */
  static portInUse(bind: string): TransportError {
    return new TransportError(`Port ${bind} is already in use — server cannot start`, {
      context: { bind },
      recoveryHint: `Free port or choose a different one via MCP_PORT.`,
    });
  }

  /**
   * Create an error for insufficient privileges to bind (EACCES).
   */
  static privilegesRequired(bind: string): TransportError {
    return new TransportError(`Binding to ${bind} requires elevated privileges`, {
      context: { bind },
      recoveryHint: "Use a port above 1024 or run with elevated privileges.",
    });
  }
}
