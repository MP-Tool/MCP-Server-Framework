/**
 * Logger Facade Module
 *
 * Provides a unified logging interface that delegates to specialized components:
 * - Context management via core/context.ts
 * - Formatting via formatters/ (Text/JSON)
 * - Output via writers/ (Console/File/MCP)
 * - Security via scrubbing/ (SecretScrubber/InjectionGuard)
 * - Resource management via factory.ts (DI-enabled)
 *
 * This facade follows the Single Responsibility Principle by coordinating
 * the logging pipeline without implementing the details itself.
 *
 * @module logger
 */

import * as util from "util";

// Core types and utilities
import type { LogLevel, TransportMode, LogContext, LoggerInterface, LogEntryParams } from "./core/types.js";
import {
  LOG_LEVELS,
  MAX_MESSAGE_LENGTH,
  TRUNCATION_SUFFIX,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVICE_NAME,
} from "./core/constants.js";
import {
  runWithContext,
  getContext,
  mergeContext,
  createChildContext,
  withExtendedContext,
  withChildContext,
  getContextDepth,
} from "./core/context.js";
import { extractTraceContext } from "./core/trace-context.js";

// Factory for DI-enabled resource management
import {
  LoggerResources,
  initializeLoggerResources,
  hasLoggerResources,
  getLoggerResources,
  resetLoggerResources,
  _setLoggerResources,
} from "./factory.js";

// Re-export factory types for consumers
export type { LoggerSystemConfig, LoggerDependencies } from "./factory.js";
export { LoggerResources, initializeLoggerResources, resetLoggerResources };

// ============================================================================
// Global Logger Configuration
// ============================================================================

/**
 * Global logger configuration.
 * Must be set before creating logger instances.
 */
export interface GlobalLoggerConfig {
  /** Log level */
  LOG_LEVEL: LogLevel;
  /** Log format */
  LOG_FORMAT: "text" | "json";
  /** Transport mode */
  MCP_TRANSPORT: TransportMode;
  /** Node environment */
  NODE_ENV: "development" | "production" | "test";
  /** Log directory (optional) */
  LOG_DIR?: string | undefined;
  /** Maximum log file size in bytes before rotation */
  LOG_MAX_FILE_SIZE?: number | undefined;
  /** Number of rotated log files to keep */
  LOG_MAX_FILES?: number | undefined;
  /** Log file retention in days (0 = disabled) */
  LOG_RETENTION_DAYS?: number | undefined;
  /** Include timestamps in text log output */
  LOG_TIMESTAMP?: boolean | undefined;
  /** Include component name in text log output */
  LOG_COMPONENT?: boolean | undefined;
  /** Server name */
  SERVER_NAME: string;
  /** Server version */
  SERVER_VERSION: string;
}

/**
 * Default logger configuration.
 * Used when no explicit config is provided.
 */
const DEFAULT_LOGGER_CONFIG: GlobalLoggerConfig = {
  LOG_LEVEL: DEFAULT_LOG_LEVEL,
  LOG_FORMAT: "text",
  MCP_TRANSPORT: "stdio",
  // @node-api — process.env.* returns string | undefined; config requires string literal union
  NODE_ENV: (process.env.NODE_ENV ?? "development") as GlobalLoggerConfig["NODE_ENV"],
  SERVER_NAME: DEFAULT_SERVICE_NAME,
  SERVER_VERSION: "0.0.0",
};

/** Global logger configuration storage */
let globalLoggerConfig: GlobalLoggerConfig = { ...DEFAULT_LOGGER_CONFIG };

/**
 * Configure the global logger settings.
 * Should be called once at application startup before creating loggers.
 *
 * @param config - Logger configuration options
 *
 * @example
 * ```typescript
 * // In app initialization
 * configureLogger({
 *   LOG_LEVEL: config.LOG_LEVEL,
 *   LOG_FORMAT: config.LOG_FORMAT,
 *   MCP_TRANSPORT: config.MCP_TRANSPORT,
 *   NODE_ENV: config.NODE_ENV,
 *   LOG_DIR: config.LOG_DIR,
 *   SERVER_NAME: 'mcp-server',
 *   SERVER_VERSION: '1.0.0',
 * });
 * ```
 */
export function configureLogger(config: Partial<GlobalLoggerConfig>): void {
  globalLoggerConfig = { ...globalLoggerConfig, ...config };

  // Close and reset resources so the next log call re-creates them with the new config.
  // This is necessary because LoggerResources captures formatter settings
  // (e.g., includeTimestamp, includeComponent) at construction time.
  // Must use resetLoggerResources() (not _setLoggerResources(null)) to properly
  // close existing FileWriter streams and clear rotation/retention timers.
  if (hasLoggerResources()) {
    void resetLoggerResources();
  }
}

/**
 * Get the current global logger configuration.
 */
export function getLoggerConfig(): GlobalLoggerConfig {
  return globalLoggerConfig;
}

/**
 * Reset the global logger configuration to defaults.
 * Primarily for testing.
 */
export function resetLoggerConfig(): void {
  globalLoggerConfig = { ...DEFAULT_LOGGER_CONFIG };
}

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  /** Component name for log categorization */
  component?: string;
  /** Override log level (uses config.LOG_LEVEL by default) */
  level?: LogLevel;
  /** Optional resources instance (for testing/DI) */
  resources?: LoggerResources;
}

/**
 * Centralized Logger Facade
 *
 * Coordinates the logging pipeline:
 * 1. Level filtering
 * 2. Message formatting (printf-style)
 * 3. Metadata extraction
 * 4. Secret scrubbing
 * 5. Formatting (Text/JSON)
 * 6. Injection prevention
 * 7. Output to writers (Console/File/MCP)
 *
 * Now uses LoggerResources for DI-enabled resource management,
 * eliminating the static state anti-pattern while maintaining
 * backward compatibility through lazy global initialization.
 *
 * @example
 * ```typescript
 * // Simple usage (global resources)
 * const logger = new Logger('api');
 * logger.info('Request received', { method: 'GET', path: '/health' });
 *
 * // DI usage (custom resources for testing)
 * const resources = new LoggerResources(config, mockDeps);
 * const testLogger = new Logger({ component: 'test', resources });
 * ```
 */
export class Logger implements LoggerInterface {
  // ============================================================
  // Instance properties
  // ============================================================

  /** Override log level (if set in options, otherwise uses global config) */
  private readonly levelOverride: LogLevel | undefined;

  /** Component name for this logger instance */
  private readonly component: string;

  /** Explicitly injected resources (DI/testing only) — `null` means use global */
  private readonly _injectedResources: LoggerResources | null;

  /** Resolve the active resources: injected for DI, otherwise global (dynamic). */
  private get resources(): LoggerResources {
    return this._injectedResources ?? Logger.getOrInitializeResources();
  }

  /**
   * Get the effective log level (numeric for fast comparison).
   * Uses override if set, otherwise reads from global config dynamically.
   */
  private get level(): number {
    const effectiveLevel = this.levelOverride ?? getLoggerConfig().LOG_LEVEL;
    return LOG_LEVELS[effectiveLevel];
  }

  // ============================================================
  // Constructor and Initialization
  // ============================================================

  /**
   * Create a new Logger instance.
   *
   * @param componentOrOptions - Component name string or options object
   */
  constructor(componentOrOptions: string | LoggerOptions = "server") {
    if (typeof componentOrOptions === "string") {
      this.component = componentOrOptions;
      this.levelOverride = undefined; // Use global config dynamically
      this._injectedResources = null; // Resolve from global on each log call
    } else {
      this.component = componentOrOptions.component ?? "server";
      this.levelOverride = componentOrOptions.level; // Override if explicitly set
      this._injectedResources = componentOrOptions.resources ?? null;
    }
  }

  /**
   * Get or initialize global resources lazily.
   * Provides backward compatibility with existing code.
   */
  private static getOrInitializeResources(): LoggerResources {
    if (!hasLoggerResources()) {
      const cfg = getLoggerConfig();
      initializeLoggerResources({
        level: cfg.LOG_LEVEL,
        format: cfg.LOG_FORMAT,
        transport: cfg.MCP_TRANSPORT,
        serviceName: cfg.SERVER_NAME,
        serviceVersion: cfg.SERVER_VERSION,
        environment: cfg.NODE_ENV,
        ...(cfg.LOG_DIR !== undefined && { logDir: cfg.LOG_DIR }),
        ...(cfg.LOG_MAX_FILE_SIZE !== undefined && {
          maxFileSize: cfg.LOG_MAX_FILE_SIZE,
        }),
        ...(cfg.LOG_MAX_FILES !== undefined && { maxFiles: cfg.LOG_MAX_FILES }),
        ...(cfg.LOG_RETENTION_DAYS !== undefined && {
          retentionDays: cfg.LOG_RETENTION_DAYS,
        }),
        ...(cfg.LOG_TIMESTAMP !== undefined && {
          includeTimestamp: cfg.LOG_TIMESTAMP,
        }),
        ...(cfg.LOG_COMPONENT !== undefined && {
          includeComponent: cfg.LOG_COMPONENT,
        }),
      });
    }
    return getLoggerResources();
  }

  // ============================================================
  // Static Lifecycle Methods
  // ============================================================

  /**
   * Close all writers gracefully.
   * Should be called during application shutdown.
   *
   * @returns Promise that resolves when all writers are closed
   */
  public static async closeStreams(): Promise<void> {
    if (hasLoggerResources()) {
      await getLoggerResources().close();
      await resetLoggerResources();
    }
  }

  /**
   * Clear the child logger cache.
   * Useful for testing or when configuration changes.
   */
  public static clearChildLoggerCache(): void {
    if (hasLoggerResources()) {
      getLoggerResources().clearChildLoggerCache();
    }
  }

  /**
   * Reset static state (for testing purposes).
   * Fully resets all resources.
   */
  public static async resetState(): Promise<void> {
    await resetLoggerResources();
  }

  // ============================================================
  // Child Logger Factory
  // ============================================================

  /**
   * Create a child logger with a specific component context.
   * Uses LRU caching to avoid creating new instances while preventing memory leaks.
   *
   * @param context - The component context for the child logger
   * @returns A cached or new Logger instance
   */
  public child(context: { component: string }): Logger {
    return this.resources.getOrCreateChildLogger(context.component, () =>
      this._injectedResources
        ? new Logger({
            component: context.component,
            resources: this._injectedResources,
          })
        : new Logger({ component: context.component }),
    );
  }

  // ============================================================
  // Context Management (delegates to core/context.ts)
  // ============================================================

  /**
   * Run a function within a logging context.
   * All logs within the function will include the context.
   *
   * @param context - The context to use for logging
   * @param fn - The function to execute
   * @returns The result of the function
   */
  public runWithContext<T>(context: LogContext, fn: () => T): T {
    return runWithContext(context, fn);
  }

  /**
   * Get the current logging context.
   *
   * @returns The current context or undefined
   */
  public getContext(): LogContext | undefined {
    return getContext();
  }

  /**
   * Merge additional context with the current context.
   *
   * @param additionalContext - Context values to add/override
   * @returns A new merged context
   */
  public mergeContext(additionalContext: Partial<LogContext>): LogContext {
    return mergeContext(additionalContext);
  }

  /**
   * Create a child context that inherits from the current context.
   * Component names are automatically concatenated.
   *
   * @param childContext - Context values for the child
   * @returns A new child context
   */
  public createChildContext(childContext: Partial<LogContext>): LogContext {
    return createChildContext(childContext);
  }

  /**
   * Execute a function with an extended context.
   *
   * @param additionalContext - Context values to add
   * @param fn - The function to execute
   * @returns The result of the function
   */
  public withExtendedContext<T>(additionalContext: Partial<LogContext>, fn: () => T): T {
    return withExtendedContext(additionalContext, fn);
  }

  /**
   * Execute a function with a child context.
   *
   * @param childContext - Context values for the child scope
   * @param fn - The function to execute
   * @returns The result of the function
   */
  public withChildContext<T>(childContext: Partial<LogContext>, fn: () => T): T {
    return withChildContext(childContext, fn);
  }

  /**
   * Get the current context nesting depth.
   *
   * @returns The current depth
   */
  public getContextDepth(): number {
    return getContextDepth();
  }

  // ============================================================
  // Log Level Methods
  // ============================================================

  /**
   * Log a message at TRACE level.
   */
  public trace(message: string, ...args: unknown[]): void {
    this.log("trace", message, ...args);
  }

  /**
   * Log a message at DEBUG level.
   */
  public debug(message: string, ...args: unknown[]): void {
    this.log("debug", message, ...args);
  }

  /**
   * Log a message at INFO level.
   */
  public info(message: string, ...args: unknown[]): void {
    this.log("info", message, ...args);
  }

  /**
   * Log a message at WARN level.
   */
  public warn(message: string, ...args: unknown[]): void {
    this.log("warn", message, ...args);
  }

  /**
   * Log a message at ERROR level.
   */
  public error(message: string, ...args: unknown[]): void {
    this.log("error", message, ...args);
  }

  // ============================================================
  // Core Logging Pipeline
  // ============================================================

  /**
   * Internal log handler implementing the logging pipeline.
   *
   * Pipeline steps:
   * 1. Level filtering
   * 2. Metadata extraction
   * 3. Printf-style formatting
   * 4. Message truncation (if exceeds MAX_MESSAGE_LENGTH)
   * 5. Context retrieval
   * 6. Secret scrubbing
   * 7. Format generation (Text/JSON)
   * 8. Injection prevention
   * 9. Output to writers
   * 10. MCP notification (if context has sendMcpLog)
   */
  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    // Step 1: Level filtering (fast path for disabled levels)
    if (LOG_LEVELS[level] < this.level) {
      this.forwardToMcpBridge(level, message, args);
      return;
    }

    // Step 2: Extract metadata and error from args
    const { metadata, error, formatArgs } = this.extractMetadata(args);

    // Step 3: Printf-style message formatting
    let formattedMessage = util.format(message, ...formatArgs);

    // Step 4: Truncate long messages to prevent memory issues
    if (formattedMessage.length > MAX_MESSAGE_LENGTH) {
      formattedMessage = formattedMessage.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
    }

    // Step 5: Get context (from AsyncLocalStorage)
    const context = getContext();
    const component = context?.component ?? this.component;

    // Step 5b: Auto-enrich with OTEL trace context if not already set
    let enrichedContext = context;
    if (!context?.traceId) {
      const otelCtx = extractTraceContext();
      if (otelCtx) {
        enrichedContext = { ...context, ...otelCtx };
      }
    }

    // Step 6: Scrub secrets from metadata
    // @ts-limitation — scrubObject() returns unknown; object input guarantees object output
    const scrubbedMetadata = metadata
      ? (this.resources.secretScrubber.scrubObject(metadata) as Record<string, unknown>)
      : undefined;

    // Step 7: Build log entry params
    const params: LogEntryParams = {
      level,
      message: formattedMessage,
      component,
      ...(enrichedContext !== undefined && { context: enrichedContext }),
      ...(scrubbedMetadata !== undefined && { metadata: scrubbedMetadata }),
      ...(error !== undefined && { error }),
      timestamp: new Date().toISOString(),
    };

    // Step 8: Format the log entry
    const formatted = this.resources.getFormatter().format(params);

    // Step 9: Apply injection guard and secret scrubbing to final output
    const safeOutput = this.sanitizeOutput(formatted);

    // Step 10: Write to outputs
    this.writeToOutputs(level, safeOutput, component);

    // Step 11: Send to MCP client if context has sendMcpLog (best-effort)
    if (enrichedContext?.sendMcpLog) {
      try {
        const safeMessage = this.sanitizeOutput(formattedMessage);
        enrichedContext.sendMcpLog(level, safeMessage);
      } catch {
        // Silently ignore — MCP client notification is best-effort.
        // A throwing callback must never crash the caller's logging call.
      }
    }
  }

  /**
   * Forward a below-server-level message to the MCP notification bridge.
   *
   * MCP clients may request a lower log level via `logging/setLevel` than
   * the server's configured level. This method ensures those messages still
   * reach the MCP client without running the full writer pipeline (Steps 2–10).
   *
   * No-op when no `sendMcpLog` callback is present in the AsyncLocalStorage
   * context (i.e. outside of tool execution or when no session is attached).
   */
  private forwardToMcpBridge(level: LogLevel, message: string, args: unknown[]): void {
    // Trace-level messages are never forwarded to MCP clients (too verbose).
    // The filter is also enforced in createContextLogger(), but we short-circuit
    // here to avoid unnecessary string formatting work.
    if (level === "trace") {
      return;
    }

    const mcpLog = getContext()?.sendMcpLog;
    if (!mcpLog) {
      return;
    }

    const { formatArgs } = this.extractMetadata(args);
    let formatted = util.format(message, ...formatArgs);
    if (formatted.length > MAX_MESSAGE_LENGTH) {
      formatted = formatted.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
    }

    try {
      mcpLog(level, this.sanitizeOutput(formatted));
    } catch {
      // Best-effort — a throwing MCP callback must never crash the logging call.
    }
  }

  /**
   * Extract metadata object from log arguments.
   * The last argument is treated as metadata if it's a plain object (not an Error).
   */
  private extractMetadata(args: unknown[]): {
    metadata: Record<string, unknown> | undefined;
    error: Error | undefined;
    formatArgs: unknown[];
  } {
    if (args.length === 0) {
      return { metadata: undefined, error: undefined, formatArgs: [] };
    }

    let metadata: Record<string, unknown> | undefined;
    let error: Error | undefined;
    let formatArgs = args;

    const lastArg = args[args.length - 1];

    // Check if last arg is a plain object (not null, not Error)
    if (lastArg !== null && typeof lastArg === "object" && !(lastArg instanceof Error) && !Array.isArray(lastArg)) {
      // @type-narrowing — Runtime checks confirm object && !null && !Error && !Array; TS cannot narrow unknown
      metadata = lastArg as Record<string, unknown>;
      formatArgs = args.slice(0, -1);
    }

    // Check if last format arg (or the one before metadata) is an Error
    const errorCandidate = formatArgs.length > 0 ? formatArgs[formatArgs.length - 1] : undefined;
    if (errorCandidate instanceof Error) {
      error = errorCandidate;
    }

    return { metadata, error, formatArgs };
  }

  /**
   * Apply injection guard and secret scrubbing to formatted log output.
   */
  private sanitizeOutput(formatted: string): string {
    const sanitized = this.resources.injectionGuard.sanitize(formatted);
    return this.resources.secretScrubber.scrub(sanitized);
  }

  /**
   * Write formatted output to all configured writers.
   */
  private writeToOutputs(level: LogLevel, output: string, component: string): void {
    // Console writer
    this.resources.consoleWriter?.write(level, output, component);

    // File writer (if configured)
    /* v8 ignore start - file logging requires LOG_DIR environment */
    this.resources.fileWriter?.write(level, output, component);
    /* v8 ignore stop */
  }
}

/**
 * Default logger instance for the application.
 * Uses dynamic log level from global config, so configureLogger()
 * can be called at any time to change the effective log level.
 */
export const logger = new Logger();
