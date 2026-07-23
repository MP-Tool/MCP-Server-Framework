/**
 * Logger configuration bridge.
 *
 * Applies the resolved framework `LOG_*` / `MCP_TRANSPORT` config to the global
 * logger. Used internally by the server at startup, and exported so consumers
 * that log during bootstrap — before `createServer()` runs — can align the
 * logger's formatting (timestamps, component tags, file output) up front rather
 * than emitting a few bare-format lines first. Safe to call more than once:
 * `configureLogger()` disposes the previous file streams before reapplying.
 *
 * @module server/logger-config
 */

import { configureLogger } from "../logger/index.js";
import { getFrameworkConfig } from "../config/index.js";

/**
 * Configure the global logger from the resolved framework environment config.
 *
 * @param options.name - Server name for structured logs (default: config/service name)
 * @param options.version - Server version for structured logs
 */
export function configureLoggerFromEnv(options: { name?: string; version?: string } = {}): void {
  const config = getFrameworkConfig();
  configureLogger({
    LOG_LEVEL: config.LOG_LEVEL,
    LOG_FORMAT: config.LOG_FORMAT,
    LOG_DIR: config.LOG_DIR,
    LOG_MAX_FILE_SIZE: config.LOG_MAX_FILE_SIZE,
    LOG_MAX_FILES: config.LOG_MAX_FILES,
    LOG_RETENTION_DAYS: config.LOG_RETENTION_DAYS,
    LOG_TIMESTAMP: config.LOG_TIMESTAMP,
    LOG_COMPONENT: config.LOG_COMPONENT,
    MCP_TRANSPORT: config.MCP_TRANSPORT,
    ...(options.name !== undefined && { SERVER_NAME: options.name }),
    ...(options.version !== undefined && { SERVER_VERSION: options.version }),
  });
}
