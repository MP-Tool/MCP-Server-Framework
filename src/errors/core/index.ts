/**
 * Error Core Module - Barrel Export
 *
 * Re-exports all core error system components:
 * - Error codes and categories
 * - HTTP status codes and mappings
 * - JSON-RPC error codes
 * - Validation constants and utilities
 * - Type definitions
 * - Base error class
 * - Framework messages
 *
 * @module errors/core
 */

// ─────────────────────────────────────────────────────────────────────────
// Error Codes & Categories
// ─────────────────────────────────────────────────────────────────────────
export { ErrorCodes, ErrorCategory, type ErrorCodeType, type ErrorCategoryType } from "./error-codes.js";

// ─────────────────────────────────────────────────────────────────────────
// HTTP Constants & Mappings
// ─────────────────────────────────────────────────────────────────────────
export { HttpStatus, ErrorCodeToHttpStatus, getHttpStatusForErrorCode, type HttpStatusType } from "./http.js";

// ─────────────────────────────────────────────────────────────────────────
// JSON-RPC Constants
// ─────────────────────────────────────────────────────────────────────────
export {
  JsonRpcErrorCode,
  isSpecDefinedJsonRpcError,
  isServerDefinedJsonRpcError,
  isValidJsonRpcErrorCode,
  createJsonRpcError,
  type JsonRpcErrorCodeType,
  type JsonRpcErrorResponse,
} from "./json-rpc.js";

// ─────────────────────────────────────────────────────────────────────────
// Validation Constants & Utilities
// ─────────────────────────────────────────────────────────────────────────
export { VALIDATION_LIMITS, REDACTED_PLACEHOLDER, redactIfSensitive } from "./constants.js";

// Re-export shared utility — canonical source is utils/sensitive-keys.ts
export { isSensitiveKey } from "../../utils/sensitive-keys.js";

// ─────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────
export type { SerializedError, BaseErrorOptions, ValidationErrorOptions, ValidationIssue } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────
// Base Error Class
// ─────────────────────────────────────────────────────────────────────────
export { AppError } from "./base.js";

// ─────────────────────────────────────────────────────────────────────────
// Transport Error Messages
// ─────────────────────────────────────────────────────────────────────────
export { TransportErrorMessage, type TransportErrorMessageKey } from "./messages.js";
