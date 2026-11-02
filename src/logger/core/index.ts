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

export type { LogLevel, McpLogLevel, LoggerInterface, LoggerConfig, LogNotificationHandler } from "./types.js";

// ============================================================================
// Trace Context (Plugin Interface)
// ============================================================================

export type { TraceContext, TraceContextExtractor } from "./trace-context.js";
export { setTraceContextExtractor } from "./trace-context.js";

// ============================================================================
// Errors
// ============================================================================

export { ScrubberError } from "./errors.js";
