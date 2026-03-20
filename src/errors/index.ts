/**
 * Framework Errors Module
 *
 * This module provides the error system for the MCP server framework.
 * Application-specific errors should be created in app/errors/ by extending
 * these base classes.
 *
 * @module errors
 *
 * @example
 * ```typescript
 * import {
 *   FrameworkErrorFactory,
 *   AppError,
 *   ValidationError,
 *   ErrorCodes,
 * } from './errors/index.js';
 *
 * // Using the factory
 * throw FrameworkErrorFactory.validation.fieldRequired('name');
 *
 * // Using classes directly
 * throw new ValidationError('Invalid input', { field: 'email' });
 *
 * // Checking error types
 * if (FrameworkErrorFactory.isAppError(error)) {
 *   console.log(error.code, error.statusCode);
 * }
 * ```
 */

// ─────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────

export {
  // Error Codes & Categories
  ErrorCodes,
  ErrorCategory,
  type ErrorCodeType,
  type ErrorCategoryType,
  // HTTP
  HttpStatus,
  ErrorCodeToHttpStatus,
  getHttpStatusForErrorCode,
  type HttpStatusType,
  // JSON-RPC
  JsonRpcErrorCode,
  isSpecDefinedJsonRpcError,
  isServerDefinedJsonRpcError,
  isValidJsonRpcErrorCode,
  createJsonRpcError,
  type JsonRpcErrorCodeType,
  type JsonRpcErrorResponse,
  // Validation
  VALIDATION_LIMITS,
  REDACTED_PLACEHOLDER,
  isSensitiveKey,
  redactIfSensitive,
  // Base Error
  AppError,
  // Transport Error Messages
  TransportErrorMessage,
} from "./core/index.js";

export type {
  // Types
  SerializedError,
  BaseErrorOptions,
  ValidationErrorOptions,
  ValidationIssue,
  // Messages
  TransportErrorMessageKey,
} from "./core/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Error Categories
// ─────────────────────────────────────────────────────────────────────────

export {
  // MCP Protocol
  McpProtocolError,
  SessionError,
  TransportError,
  // Validation
  ValidationError,
  ConfigurationError,
  // System
  InternalError,
  RegistryError,
  // Operation
  OperationError,
  OperationCancelledError,
  // Connection
  ConnectionError,
  // Auth
  AuthenticationError,
  AuthorizationError,
} from "./categories/index.js";

// ─────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────

export { FrameworkErrorFactory, type FrameworkErrorFactoryType } from "./factory.js";
