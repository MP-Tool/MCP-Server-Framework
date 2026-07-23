/**
 * Logger Module — Public API
 *
 * Centralized logging for the MCP server framework.
 * Only exports what consumers need. Internal components (writers, formatters,
 * context) are accessed via direct imports within the logger module.
 * `SecretScrubber`/`REDACTED_VALUE` are deliberately public: consumers scrub
 * secrets out of their own payloads (e.g. MCP tool output) with the same
 * engine and marker the framework uses for logs.
 *
 * ## Usage
 *
 * ```typescript
 * import { logger, configureLogger } from './logger/index.js';
 *
 * configureLogger({
 *   LOG_LEVEL: 'info',
 *   LOG_FORMAT: 'text',
 *   MCP_TRANSPORT: 'http',
 *   NODE_ENV: 'production',
 *   SERVER_NAME: 'my-mcp-server',
 *   SERVER_VERSION: '1.0.0',
 * });
 *
 * logger.info('Server started on port %d', 8000);
 *
 * const apiLogger = logger.child({ component: 'api' });
 * apiLogger.debug('Processing request');
 * ```
 *
 * @module logger
 */

// =============================================================================
// Core Types
// =============================================================================

export type { LogLevel, LoggerInterface, LoggerConfig } from "./core/index.js";

export type { LoggerOptions } from "./logger.js";

// =============================================================================
// Main Logger
// =============================================================================

export { logger, Logger } from "./logger.js";

export { configureLogger, getLoggerConfig } from "./logger.js";

// =============================================================================
// MCP Logger (notifications to connected clients)
// =============================================================================

export { mcpLogger } from "./mcp-logger.js";

// =============================================================================
// Secret Scrubbing (consumer-facing: scrub secrets out of arbitrary payloads,
// e.g. tool output, before it leaves the server)
// =============================================================================

export { SecretScrubber, createSecretScrubber, scrubByMimeType, REDACTED_VALUE } from "../utils/scrubbing/index.js";
export type { SecretScrubberOptions, SecretScrubberConfig } from "../utils/scrubbing/index.js";

// =============================================================================
// Audit Trail (level-independent JSONL sink — own data path, not the log pipeline)
// =============================================================================

export { logAuditEvent, initializeAuditLog, resolveAuditFilePath } from "./audit/index.js";
export type { AuditEvent, AuditActor, AuditCategory, AuditOutcome, AuditLogOptions } from "./audit/index.js";
