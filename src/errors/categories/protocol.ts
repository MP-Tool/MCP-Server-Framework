/**
 * MCP Protocol Error
 *
 * Error for MCP protocol violations (invalid JSON-RPC, missing method, etc.)
 *
 * @module errors/categories/protocol
 */

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { AppError, ErrorCodes, HttpStatus, JsonRpcErrorCode } from "../core/index.js";
import type { BaseErrorOptions } from "../core/index.js";

// ============================================================================
// MCP Protocol Error
// ============================================================================

/**
 * Error thrown for MCP protocol violations.
 *
 * @example
 * ```typescript
 * throw McpProtocolError.invalidJson();
 * throw McpProtocolError.invalidRequest('Missing required field');
 * ```
 */
export class McpProtocolError extends AppError {
  /** JSON-RPC error code */
  readonly jsonRpcCode: number;

  constructor(message: string, jsonRpcCode?: number, options: Omit<BaseErrorOptions, "code"> = {}) {
    super(message, {
      code: ErrorCodes.INVALID_REQUEST,
      statusCode: HttpStatus.BAD_REQUEST,
      mcpCode: ErrorCode.InvalidRequest,
      cause: options.cause,
      recoveryHint: options.recoveryHint,
      context: {
        ...options.context,
        jsonRpcCode: jsonRpcCode ?? JsonRpcErrorCode.INVALID_REQUEST,
      },
    });

    this.jsonRpcCode = jsonRpcCode ?? JsonRpcErrorCode.INVALID_REQUEST;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generic Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a generic invalid request error.
   */
  static invalidRequest(reason: string): McpProtocolError {
    return new McpProtocolError(`Invalid request: ${reason}`, JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: "Check the request format and required fields.",
    });
  }

  /**
   * Create a method not found error.
   */
  static methodNotFound(method: string): McpProtocolError {
    return new McpProtocolError(`Method not found: ${method}`, JsonRpcErrorCode.METHOD_NOT_FOUND, {
      context: { method },
      recoveryHint: `The method '${method}' does not exist. Check the method name.`,
    });
  }

  /**
   * Create an invalid params error.
   */
  static invalidParams(reason: string): McpProtocolError {
    return new McpProtocolError(`Invalid params: ${reason}`, JsonRpcErrorCode.INVALID_PARAMS, {
      recoveryHint: "Check the method parameters against the expected schema.",
    });
  }

  /**
   * Create a parse error.
   */
  static parseError(reason: string): McpProtocolError {
    return new McpProtocolError(`Parse error: ${reason}`, JsonRpcErrorCode.PARSE_ERROR, {
      recoveryHint: "Ensure the request body contains valid JSON syntax.",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Specific Factory Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an error for invalid JSON.
   */
  static invalidJson(): McpProtocolError {
    return new McpProtocolError("Invalid JSON", JsonRpcErrorCode.PARSE_ERROR, {
      recoveryHint: "Ensure the request body contains valid JSON syntax.",
    });
  }

  /**
   * Create an error for invalid JSON-RPC version.
   */
  static invalidJsonRpc(): McpProtocolError {
    return new McpProtocolError("Invalid JSON-RPC version", JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: 'Ensure the request includes "jsonrpc": "2.0" field.',
    });
  }

  /**
   * Create an error for missing method field.
   */
  static missingMethod(): McpProtocolError {
    return new McpProtocolError("Missing method field", JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: 'Include a "method" field in the JSON-RPC request.',
    });
  }

  /**
   * Create an error for invalid batch request.
   */
  static invalidBatch(): McpProtocolError {
    return new McpProtocolError("Invalid batch request: array must not be empty", JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: "Batch requests must be a non-empty JSON array.",
    });
  }

  /**
   * Create an error for invalid content type.
   */
  static invalidContentType(): McpProtocolError {
    return new McpProtocolError("Content-Type must be application/json", JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: 'Set Content-Type header to "application/json".',
    });
  }

  /**
   * Create an error for missing Accept header.
   */
  static missingAccept(): McpProtocolError {
    return new McpProtocolError("Missing Accept header", JsonRpcErrorCode.INVALID_REQUEST, {
      recoveryHint: "Include an Accept header with supported content types.",
    });
  }

  /**
   * Create an error for cancelled request.
   */
  static requestCancelled(): McpProtocolError {
    return new McpProtocolError("Request was cancelled", JsonRpcErrorCode.REQUEST_CANCELLED, {
      recoveryHint: "The request was cancelled. Retry the operation if needed.",
    });
  }
}
