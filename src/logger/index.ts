/**
 * Logger Module — Public API
 *
 * Centralized logging for the MCP server framework.
 * Only exports what consumers need. Internal components (writers, formatters,
 * scrubbing, context, constants) are accessed via direct imports within
 * the logger module.
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
} from "./core/index.js";

export type { LoggerOptions } from "./logger.js";

export { LoggerResources, type LoggerSystemConfig, type LoggerDependencies } from "./factory.js";

export { SecretScrubber } from "./scrubbing/index.js";
export { InjectionGuard } from "./scrubbing/index.js";

// =============================================================================
// Main Logger
// =============================================================================

export { logger, Logger } from "./logger.js";

export { configureLogger, getLoggerConfig, resetLoggerConfig, type GlobalLoggerConfig } from "./logger.js";

// =============================================================================
// MCP Logger (notifications to connected clients)
// =============================================================================

export { mcpLogger, McpNotificationLogger, type McpLoggerConfig } from "./mcp-logger.js";
