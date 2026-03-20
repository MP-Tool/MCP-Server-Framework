/**
 * Logger Factory Module
 *
 * Provides dependency injection and testable configuration for the logging system.
 * Eliminates static state anti-pattern while maintaining backward compatibility.
 *
 * @module logger/factory
 */

import type { LogLevel, TransportMode, LogFormatter, LogWriter } from "./core/types.js";
import { hostname as osHostname } from "os";
import { TextFormatter } from "./formatters/text-formatter.js";
import { JsonFormatter } from "./formatters/json-formatter.js";
import { ConsoleWriter } from "./writers/console-writer.js";
import { FileWriter } from "./writers/file-writer.js";
import { SecretScrubber } from "./scrubbing/secret-scrubber.js";
import { InjectionGuard } from "./scrubbing/injection-guard.js";
import { MAX_CHILD_LOGGER_CACHE_SIZE } from "./core/constants.js";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Complete configuration for the logging system.
 */
export interface LoggerSystemConfig {
  /** Minimum log level */
  level: LogLevel;
  /** Output format (text or json) */
  format: "text" | "json";
  /** Transport mode (affects console output) */
  transport: TransportMode;
  /** Service name for structured logs */
  serviceName: string;
  /** Service version for structured logs */
  serviceVersion: string;
  /** Environment name */
  environment: string;
  /** Directory for file logging (optional) */
  logDir?: string;
  /** Maximum size of child logger cache */
  maxChildLoggerCacheSize?: number;
  /** Maximum log file size in bytes before rotation */
  maxFileSize?: number;
  /** Number of rotated log files to keep */
  maxFiles?: number;
  /** Log file retention in days (0 = disabled) */
  retentionDays?: number;
  /** Include RFC 3339 timestamps in text log output (default: true) */
  includeTimestamp?: boolean;
  /** Include component name in text log output (default: true) */
  includeComponent?: boolean;
  /** Hostname (computed once at init via os.hostname()) */
  hostname?: string;
  /** CPU architecture (default: process.arch) */
  architecture?: string;
  /** OS type / platform (default: process.platform) */
  osType?: string;
  /** Process ID (default: process.pid) */
  pid?: number;
  /** Process name (default: 'node') */
  processName?: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface LoggerDependencies {
  textFormatter?: LogFormatter;
  jsonFormatter?: LogFormatter;
  consoleWriter?: LogWriter;
  fileWriter?: LogWriter;
  secretScrubber?: SecretScrubber;
  injectionGuard?: InjectionGuard;
}

// ============================================================================
// Logger Resources Container
// ============================================================================

/**
 * Container for logger resources.
 * Encapsulates all shared resources that were previously static.
 */
export class LoggerResources {
  readonly textFormatter: LogFormatter;
  readonly jsonFormatter: LogFormatter | null;
  readonly consoleWriter: LogWriter | null;
  readonly fileWriter: LogWriter | null;
  readonly secretScrubber: SecretScrubber;
  readonly injectionGuard: InjectionGuard;
  readonly format: "text" | "json";
  readonly maxChildLoggerCacheSize: number;

  /** Child logger cache with LRU eviction */
  private readonly childLoggerCache = new Map<string, unknown>();
  private readonly childLoggerOrder: string[] = [];

  constructor(config: LoggerSystemConfig, deps: LoggerDependencies = {}) {
    this.format = config.format;
    this.maxChildLoggerCacheSize = config.maxChildLoggerCacheSize ?? MAX_CHILD_LOGGER_CACHE_SIZE;

    // Initialize formatters
    this.textFormatter =
      deps.textFormatter ??
      new TextFormatter({
        includeTimestamp: config.includeTimestamp,
        includeComponent: config.includeComponent,
      });

    // Resolve host/process info once (defaulting from runtime)
    const resolvedHostname = config.hostname ?? osHostname();
    const resolvedArch = config.architecture ?? process.arch;
    const resolvedOsType = config.osType ?? process.platform;
    const resolvedPid = config.pid ?? process.pid;
    const resolvedProcessName = config.processName ?? "node";

    this.jsonFormatter =
      config.format === "json"
        ? (deps.jsonFormatter ??
          new JsonFormatter({
            serviceName: config.serviceName,
            serviceVersion: config.serviceVersion,
            environment: config.environment,
            hostname: resolvedHostname,
            architecture: resolvedArch,
            osType: resolvedOsType,
            pid: resolvedPid,
            processName: resolvedProcessName,
          }))
        : null;

    // Initialize writers
    this.consoleWriter =
      deps.consoleWriter ??
      new ConsoleWriter({
        transport: config.transport,
      });

    // File writer (optional)
    this.fileWriter = config.logDir
      ? (deps.fileWriter ??
        this.createFileWriter(config.logDir, config.maxFileSize, config.maxFiles, config.retentionDays))
      : null;

    // Security components
    this.secretScrubber = deps.secretScrubber ?? new SecretScrubber();
    this.injectionGuard = deps.injectionGuard ?? new InjectionGuard();
  }

  /**
   * Create file writer with error handling.
   */
  private createFileWriter(
    logDir: string,
    maxFileSize?: number,
    maxFiles?: number,
    retentionDays?: number,
  ): LogWriter | null {
    try {
      return new FileWriter({ logDir, maxFileSize, maxFiles, retentionDays });
    } catch {
      // File logging is optional, continue without it
      return null;
    }
  }

  /**
   * Get the appropriate formatter based on configuration.
   */
  getFormatter(): LogFormatter {
    return this.format === "json" && this.jsonFormatter ? this.jsonFormatter : this.textFormatter;
  }

  /**
   * Get or create a cached child logger.
   * Uses LRU eviction to prevent memory leaks.
   */
  getOrCreateChildLogger<T>(key: string, factory: () => T): T {
    const cached = this.childLoggerCache.get(key);
    if (cached) {
      // Move to end of order (most recently used)
      const index = this.childLoggerOrder.indexOf(key);
      if (index > -1) {
        this.childLoggerOrder.splice(index, 1);
      }
      this.childLoggerOrder.push(key);
      // @ts-limitation — Map<string, unknown> stores base type; generic T is guaranteed by cache key
      return cached as T;
    }

    // Evict oldest entries if cache is full (LRU)
    while (this.childLoggerCache.size >= this.maxChildLoggerCacheSize && this.childLoggerOrder.length > 0) {
      const oldest = this.childLoggerOrder.shift();
      if (oldest) {
        this.childLoggerCache.delete(oldest);
      }
    }

    const newLogger = factory();
    this.childLoggerCache.set(key, newLogger);
    this.childLoggerOrder.push(key);
    return newLogger;
  }

  /**
   * Clear the child logger cache.
   */
  clearChildLoggerCache(): void {
    this.childLoggerCache.clear();
    this.childLoggerOrder.length = 0;
  }

  /**
   * Get the current cache size.
   */
  getChildLoggerCacheSize(): number {
    return this.childLoggerCache.size;
  }

  /**
   * Get child logger cache statistics for monitoring.
   * @internal
   */
  getChildLoggerCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.childLoggerCache.size,
      maxSize: this.maxChildLoggerCacheSize,
    };
  }

  /**
   * Close all writers gracefully.
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    if (this.fileWriter) {
      closePromises.push(this.fileWriter.close());
    }

    if (this.consoleWriter) {
      closePromises.push(this.consoleWriter.close());
    }

    const results = await Promise.allSettled(closePromises);
    for (const result of results) {
      if (result.status === "rejected") {
        // Use stderr directly — the logger itself is being closed
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        process.stderr.write(`[logger] Writer close failed: ${reason}\n`);
      }
    }
  }
}

// ============================================================================
// Global Resources (Singleton for backward compatibility)
// ============================================================================

/**
 * Global resources instance.
 * Provides backward compatibility with existing static Logger usage.
 * @internal
 */
let globalResources: LoggerResources | null = null;

/**
 * Initialize global logger resources.
 * Called once with the application configuration.
 *
 * @param config - Logger system configuration
 * @param deps - Optional dependencies for testing
 * @returns The initialized resources
 */
export function initializeLoggerResources(config: LoggerSystemConfig, deps?: LoggerDependencies): LoggerResources {
  if (globalResources) {
    // Already initialized - return existing instance
    return globalResources;
  }

  globalResources = new LoggerResources(config, deps);
  return globalResources;
}

/**
 * Get the global logger resources.
 * Throws if not initialized.
 *
 * @returns The global resources
 * @throws Error if resources not initialized
 */
export function getLoggerResources(): LoggerResources {
  if (!globalResources) {
    throw new Error("Logger resources not initialized. Call initializeLoggerResources() first.");
  }
  return globalResources;
}

/**
 * Check if global resources are initialized.
 */
export function hasLoggerResources(): boolean {
  return globalResources !== null;
}

/**
 * Reset global resources (for testing).
 * Closes existing resources before resetting.
 *
 * @internal
 */
export async function resetLoggerResources(): Promise<void> {
  if (globalResources) {
    await globalResources.close();
    globalResources = null;
  }
}

/**
 * Force set global resources (for testing only).
 * Bypasses initialization check.
 *
 * @internal
 */
export function _setLoggerResources(resources: LoggerResources | null): void {
  globalResources = resources;
}
