/**
 * Logger Core Module
 *
 * Exports the fundamental types, constants, and context management
 * for the logging system. This is the foundation that all other
 * logger components build upon.
 *
 * @module logger/core
 */

// ============================================================================
// Types
// ============================================================================

export type {
  LogLevel,
  McpLogLevel,
  TransportMode,
  HttpContext,
  EventContext,
  LogContext,
  LoggerInterface,
  LogWriter,
  LogFormatter,
  LogEntryParams,
  LoggerConfig,
  LogNotificationHandler,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

export {
  // Log level configuration
  LOG_LEVELS,
  LOG_SEVERITY,
  LOG_LEVEL_TO_MCP,
  MCP_LEVEL_ORDER,
  // Default configuration
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_FORMAT,
  DEFAULT_SERVICE_NAME,
  // Formatting constants
  ID_DISPLAY_LENGTH,
  LEVEL_PAD_LENGTH,
  LOG_FILE_EXTENSION,
  DEFAULT_LOG_COMPONENTS,
  LOGGER_COMPONENTS,
  // Security constants (scrubbing)
  SENSITIVE_KEYS,
  SENSITIVE_KEY_BLOCKLIST,
  REDACTED_VALUE,
  JWT_PREFIX,
  // Security constants (injection prevention)
  CONTROL_CHAR_REPLACEMENTS,
  CONTROL_CHAR_PATTERN,
  ANSI_ESCAPE_PATTERN,
  // Context constants
  MAX_CONTEXT_DEPTH,
  COMPONENT_SEPARATOR,
  // Performance constants
  MAX_CHILD_LOGGER_CACHE_SIZE,
  MAX_MESSAGE_LENGTH,
  TRUNCATION_SUFFIX,
} from "./constants.js";

// Export types from constants
export type { SensitiveKey } from "./constants.js";

// ============================================================================
// Context Management
// ============================================================================

export {
  // Core context functions
  runWithContext,
  getContext,
  getContextValue,
  hasContext,
  // Context manipulation
  mergeContext,
  createChildContext,
  withExtendedContext,
  withChildContext,
  // Utilities
  getContextDepth,
} from "./context.js";

// ============================================================================
// Trace Context (Plugin Interface)
// ============================================================================

export type { TraceContext, TraceContextExtractor } from "./trace-context.js";
export { setTraceContextExtractor, extractTraceContext } from "./trace-context.js";

// ============================================================================
// Errors
// ============================================================================

export { LoggerErrorCode, LoggerError, LoggerInitError, WriterError, FormatterError, ScrubberError } from "./errors.js";

export type { LoggerErrorCodeType } from "./errors.js";

// ============================================================================
// Formatting Utilities
// ============================================================================

export { formatSessionId, formatRequestId, formatTraceId } from "./format.js";
