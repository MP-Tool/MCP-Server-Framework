/**
 * Framework Diagnostic Logger for OpenTelemetry
 *
 * Custom {@link DiagLogger} implementation that routes OpenTelemetry SDK
 * diagnostic output through the framework's logging system instead of
 * using the default {@link DiagConsoleLogger} which writes to stdout.
 *
 * ## Why not DiagConsoleLogger?
 *
 * 1. **Stdio-Transport Conflict**: MCP Stdio transport reserves stdout
 *    for protocol data. DiagConsoleLogger writes INFO/DEBUG to stdout,
 *    which corrupts the MCP message stream.
 * 2. **Consistent Format**: Framework logger applies structured formatting
 *    (text or JSON/ECS), secret scrubbing, and timestamp formatting.
 * 3. **Unified Output**: All diagnostic output goes through stderr
 *    (via the framework logger) regardless of transport mode.
 *
 * @module server/telemetry/core/diag-logger
 */

import type { DiagLogger } from "@opentelemetry/api";

import { logger as baseLogger } from "../../logger/index.js";
import { TELEMETRY_LOG_COMPONENTS } from "./constants.js";

const logger = baseLogger.child({ component: TELEMETRY_LOG_COMPONENTS.SDK });

/**
 * DiagLogger that delegates to the framework logger.
 *
 * Maps OTEL diagnostic levels to framework log levels:
 * - `error()` → `logger.error()`
 * - `warn()` → `logger.warn()`
 * - `info()` → `logger.info()`
 * - `debug()` → `logger.debug()`
 * - `verbose()` → `logger.debug()` (framework has no verbose level)
 *
 * All output goes to stderr via the framework's writer pipeline,
 * preventing stdout pollution that would break Stdio transport.
 */
export const frameworkDiagLogger: DiagLogger = {
  error(message: string, ...args: unknown[]): void {
    logger.error(`[OTEL] ${message}`, ...args);
  },

  warn(message: string, ...args: unknown[]): void {
    logger.warn(`[OTEL] ${message}`, ...args);
  },

  info(message: string, ...args: unknown[]): void {
    logger.info(`[OTEL] ${message}`, ...args);
  },

  debug(message: string, ...args: unknown[]): void {
    logger.debug(`[OTEL] ${message}`, ...args);
  },

  verbose(message: string, ...args: unknown[]): void {
    // Framework logger has no 'verbose' level — map to trace
    logger.trace(`[OTEL:verbose] ${message}`, ...args);
  },
};
