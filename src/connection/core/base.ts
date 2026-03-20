/**
 * Connection Error Base Classes
 *
 * Provides connection-specific error handling that extends the framework's AppError.
 * Follows the same pattern as session/core/base.ts for consistency.
 *
 * @module connection/core/base
 */

import { ErrorCode as McpErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { HttpStatus } from "../../errors/index.js";

// ============================================================================
// Connection Error Codes
// ============================================================================

/**
 * Connection-specific error codes.
 *
 * These codes are local to the connection module and extend the framework's
 * error system without polluting global error definitions.
 */
export const ConnectionErrorCodes = {
  /** Connection to API server failed */
  CONNECTION_FAILED: "CONNECTION_FAILED",
  /** API server is unreachable */
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  /** Health check failed */
  HEALTH_CHECK_FAILED: "HEALTH_CHECK_FAILED",
  /** Connection timeout */
  CONNECTION_TIMEOUT: "CONNECTION_TIMEOUT",
  /** Invalid connection state transition */
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  /** Client not configured */
  CLIENT_NOT_CONFIGURED: "CLIENT_NOT_CONFIGURED",
  /** Request cancellation failed */
  CANCELLATION_FAILED: "CANCELLATION_FAILED",
  /** Progress reporting failed */
  PROGRESS_FAILED: "PROGRESS_FAILED",
} as const;

export type ConnectionErrorCode = (typeof ConnectionErrorCodes)[keyof typeof ConnectionErrorCodes];

// ============================================================================
// Error Code Mappings
// ============================================================================

/**
 * Maps connection error codes to MCP error codes.
 */
const connectionErrorToMcpCode: Record<ConnectionErrorCode, McpErrorCode> = {
  [ConnectionErrorCodes.CONNECTION_FAILED]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.SERVER_UNREACHABLE]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.HEALTH_CHECK_FAILED]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.CONNECTION_TIMEOUT]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.INVALID_STATE_TRANSITION]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.CLIENT_NOT_CONFIGURED]: McpErrorCode.InvalidRequest,
  [ConnectionErrorCodes.CANCELLATION_FAILED]: McpErrorCode.InternalError,
  [ConnectionErrorCodes.PROGRESS_FAILED]: McpErrorCode.InternalError,
};

/**
 * Maps connection error codes to HTTP status codes.
 */
const connectionErrorToHttpStatus: Record<ConnectionErrorCode, number> = {
  [ConnectionErrorCodes.CONNECTION_FAILED]: HttpStatus.SERVICE_UNAVAILABLE,
  [ConnectionErrorCodes.SERVER_UNREACHABLE]: HttpStatus.BAD_GATEWAY,
  [ConnectionErrorCodes.HEALTH_CHECK_FAILED]: HttpStatus.SERVICE_UNAVAILABLE,
  [ConnectionErrorCodes.CONNECTION_TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [ConnectionErrorCodes.INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [ConnectionErrorCodes.CLIENT_NOT_CONFIGURED]: HttpStatus.PRECONDITION_REQUIRED,
  [ConnectionErrorCodes.CANCELLATION_FAILED]: HttpStatus.INTERNAL_SERVER_ERROR,
  [ConnectionErrorCodes.PROGRESS_FAILED]: HttpStatus.INTERNAL_SERVER_ERROR,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets the MCP error code for a connection error code.
 */
export function getMcpCodeForConnectionError(code: ConnectionErrorCode): McpErrorCode {
  return connectionErrorToMcpCode[code] ?? McpErrorCode.InternalError;
}

/**
 * Gets the HTTP status code for a connection error code.
 */
export function getHttpStatusForConnectionError(code: ConnectionErrorCode): number {
  return connectionErrorToHttpStatus[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
}
