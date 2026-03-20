/**
 * File Log Writer Module
 *
 * Writes log entries to files organized by component.
 * Handles stream creation, directory management, and graceful shutdown.
 *
 * @module logger/writers/file-writer
 */

import * as fs from "fs";
import * as path from "path";
import type { LogLevel } from "../core/types.js";
import { DEFAULT_LOG_COMPONENTS, LOG_FILE_EXTENSION } from "../core/constants.js";
import { BaseLogWriter } from "./base-writer.js";

/**
 * Configuration for the file writer.
 */
export interface FileWriterConfig {
  /** Directory to write log files to */
  logDir: string;
  /** Component names to create streams for (default: ['server', 'api', 'transport']) */
  components?: readonly string[];
  /** File extension for log files (default: '.log') */
  extension?: string;
  /** Fallback component when requested component has no stream */
  fallbackComponent?: string;
  /**
   * Maximum file size in bytes before rotation (default: 10 MB).
   * When a log file exceeds this size, it is renamed to `<component>.1.log`
   * and a new file is created. Set to 0 to disable rotation.
   */
  maxFileSize?: number | undefined;
  /**
   * Maximum number of rotated files to keep per component (default: 3).
   * Older files beyond this count are deleted during rotation.
   */
  maxFiles?: number | undefined;
  /**
   * Log file retention in days. Files (including rotated) older than this
   * are deleted automatically. Set to 0 to disable (default: 0).
   */
  retentionDays?: number | undefined;
}

/**
 * File Writer class for writing logs to files.
 *
 * Features:
 * - Creates separate log files per component
 * - Size-based log rotation with configurable limits
 * - Automatic directory creation
 * - Graceful stream shutdown
 * - Fallback to default component when stream not found
 *
 * @example
 * ```typescript
 * const writer = new FileWriter({
 *   logDir: '/var/log/app',
 *   maxFileSize: 5 * 1024 * 1024, // 5 MB
 *   maxFiles: 5,
 * });
 * writer.write('info', 'Server started', 'server');
 * await writer.close();
 * ```
 */
export class FileWriter extends BaseLogWriter {
  private streams: Map<string, fs.WriteStream> = new Map();
  private logDir: string;
  private extension: string;
  private fallbackComponent: string;
  private initialized: boolean = false;

  /** Rotation config */
  private readonly maxFileSize: number;
  private readonly maxFiles: number;
  private readonly retentionDays: number;
  /** Track approximate bytes written per component for rotation checks */
  private bytesWritten: Map<string, number> = new Map();
  /** Guard against concurrent rotation */
  private rotating: Set<string> = new Set();
  /** Retention cleanup interval */
  private retentionTimer: ReturnType<typeof setInterval> | null = null;

  /** Default max file size: 10 MB */
  private static readonly DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
  /** Default max rotated files to keep */
  private static readonly DEFAULT_MAX_FILES = 3;
  /** Retention cleanup interval: once per day */
  private static readonly RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

  /**
   * Create a new FileWriter.
   * @param config - Writer configuration
   */
  constructor(config: FileWriterConfig) {
    super();
    this.logDir = config.logDir;
    this.extension = config.extension ?? LOG_FILE_EXTENSION;
    this.fallbackComponent = config.fallbackComponent ?? "server";
    this.maxFileSize = config.maxFileSize ?? FileWriter.DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = config.maxFiles ?? FileWriter.DEFAULT_MAX_FILES;
    this.retentionDays = config.retentionDays ?? 0;
    this.initialize(config.components ?? DEFAULT_LOG_COMPONENTS);
  }

  /**
   * Initialize streams for the specified components.
   */
  private initialize(components: readonly string[]): void {
    if (this.initialized) return;

    try {
      // Ensure log directory exists
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // Create streams for each component
      for (const component of components) {
        this.createStream(component);
      }

      this.initialized = true;

      // Start retention cleanup if enabled
      if (this.retentionDays > 0) {
        // Run once immediately, then periodically
        this.cleanExpiredFiles();
        this.retentionTimer = setInterval(() => this.cleanExpiredFiles(), FileWriter.RETENTION_CHECK_INTERVAL_MS);
        // Allow the process to exit even if the timer is still running
        this.retentionTimer.unref();
      }
    } catch (error) {
      // File logging is optional — report failure on stderr (stdout reserved for MCP protocol)
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[FileWriter] Initialization failed (file logging disabled): ${message}\n`);
      this.enabled = false;
    }
  }

  /**
   * Create a write stream for a component.
   * Includes error handling to prevent unhandled stream errors.
   * Initializes byte tracking from existing file size for rotation.
   */
  private createStream(component: string): boolean {
    if (this.streams.has(component)) {
      return true;
    }

    try {
      const filePath = this.getFilePath(component);
      const stream = fs.createWriteStream(filePath, { flags: "a" });

      // Handle stream errors to prevent unhandled exceptions
      stream.on("error", (err: NodeJS.ErrnoException) => {
        // Log to stderr since our logger might not be available
        process.stderr.write(`[FileWriter] Stream error for ${component}: ${err.message}\n`);
        // Remove the broken stream
        this.streams.delete(component);

        // If the log directory was deleted externally, attempt recovery
        if (err.code === "ENOENT") {
          try {
            fs.mkdirSync(this.logDir, { recursive: true });
            this.createStream(component);
          } catch {
            process.stderr.write(`[FileWriter] Directory recovery failed for ${component} — file logging disabled\n`);
          }
        }
      });

      this.streams.set(component, stream);

      // Initialize byte counter from existing file size (for rotation accuracy after restart)
      try {
        const stats = fs.statSync(filePath);
        this.bytesWritten.set(component, stats.size);
      } catch {
        this.bytesWritten.set(component, 0);
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a log message to the appropriate file.
   * Triggers rotation when the file exceeds `maxFileSize`.
   *
   * @param _level - The log level (unused for files)
   * @param message - The formatted log message
   * @param component - The component (determines which file)
   */
  write(_level: LogLevel, message: string, component: string): void {
    if (!this.enabled || !this.initialized) return;

    // Resolve effective component (fallback if stream missing)
    const effectiveComponent = this.streams.has(component) ? component : this.fallbackComponent;
    const stream = this.streams.get(effectiveComponent);
    if (!stream) return;

    const data = message + "\n";
    stream.write(data);

    // Track approximate bytes written for rotation
    const written = (this.bytesWritten.get(effectiveComponent) ?? 0) + Buffer.byteLength(data);
    this.bytesWritten.set(effectiveComponent, written);

    // Trigger rotation when file exceeds limit (skip if rotation disabled or already in progress)
    if (this.maxFileSize > 0 && written >= this.maxFileSize && !this.rotating.has(effectiveComponent)) {
      this.rotateFile(effectiveComponent);
    }
  }

  // ---------------------------------------------------------------------------
  // Rotation
  // ---------------------------------------------------------------------------

  /**
   * Rotate the log file for a component.
   *
   * Rotation chain: `server.log` → `server.1.log` → `server.2.log` → ...
   * Files beyond `maxFiles` are deleted. The current stream is replaced.
   *
   * Rotation is **synchronous** to guarantee ordering — log writes that arrive
   * during rotation are safe because Node.js is single-threaded.
   */
  private rotateFile(component: string): void {
    this.rotating.add(component);

    try {
      // 1. Close the current stream synchronously.
      //    destroy() releases the file descriptor immediately (unlike end()
      //    which queues async close). This prevents EACCES on Windows when
      //    renaming the file in step 4.
      const oldStream = this.streams.get(component);
      if (oldStream) {
        oldStream.destroy();
        this.streams.delete(component);
      }

      const basePath = this.getFilePath(component);

      // 2. Delete oldest file if it exceeds maxFiles
      const oldestPath = this.getRotatedPath(component, this.maxFiles);
      this.unlinkSafe(oldestPath);

      // 3. Shift existing rotated files: .3 → .4, .2 → .3, .1 → .2
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = this.getRotatedPath(component, i);
        const to = this.getRotatedPath(component, i + 1);
        this.renameSafe(from, to);
      }

      // 4. Rename current file to .1
      this.renameSafe(basePath, this.getRotatedPath(component, 1));

      // 5. Create a fresh stream and reset byte counter
      this.bytesWritten.set(component, 0);
      this.createStream(component);
    } catch {
      // Rotation failure must not crash the application
      process.stderr.write(`[FileWriter] Rotation failed for ${component}\n`);
    } finally {
      this.rotating.delete(component);
    }
  }

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  /**
   * Delete log files older than `retentionDays`.
   *
   * Scans the log directory for files matching the configured extension
   * and removes any whose `mtime` exceeds the retention threshold.
   * Called once at startup and then once per day.
   */
  private cleanExpiredFiles(): void {
    if (this.retentionDays <= 0) return;

    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;

    try {
      const entries = fs.readdirSync(this.logDir);
      for (const entry of entries) {
        if (!entry.endsWith(this.extension)) continue;

        const filePath = path.join(this.logDir, entry);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // best-effort: individual file errors are non-fatal
        }
      }
    } catch {
      // best-effort: directory read errors are non-fatal
    }
  }

  // ---------------------------------------------------------------------------
  // Path Helpers
  // ---------------------------------------------------------------------------

  /** Build the primary log file path for a component. */
  private getFilePath(component: string): string {
    const safeName = component.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.logDir, `${safeName}${this.extension}`);
  }

  /** Build the rotated file path: `<component>.<n><extension>` */
  private getRotatedPath(component: string, n: number): string {
    const safeName = component.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.logDir, `${safeName}.${n}${this.extension}`);
  }

  /** Rename a file if it exists; ignore errors silently. */
  private renameSafe(from: string, to: string): void {
    try {
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    } catch {
      // best-effort
    }
  }

  /** Delete a file if it exists; ignore errors silently. */
  private unlinkSafe(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // best-effort
    }
  }

  /**
   * Close all streams gracefully.
   * Should be called during application shutdown to ensure all logs are flushed.
   *
   * @returns Promise that resolves when all streams are closed
   */
  async close(): Promise<void> {
    // Stop retention timer
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }

    const closePromises: Promise<void>[] = [];

    for (const [, stream] of this.streams.entries()) {
      closePromises.push(
        new Promise<void>((resolve) => {
          stream.end(() => {
            stream.close(() => resolve());
          });
        }),
      );
    }

    await Promise.allSettled(closePromises);
    this.streams.clear();
    this.bytesWritten.clear();
    this.rotating.clear();
    this.initialized = false;
    await super.close();
  }

  /**
   * Check if the writer has been initialized successfully.
   */
  isAvailable(): boolean {
    return this.enabled && this.initialized;
  }

  /**
   * Check if a stream exists for a component.
   */
  hasStream(component: string): boolean {
    return this.streams.has(component);
  }

  /**
   * Add a new stream for a component.
   *
   * @param component - The component name
   * @returns true if stream was created successfully
   */
  addStream(component: string): boolean {
    return this.createStream(component);
  }

  /**
   * Get the number of active streams.
   */
  getStreamCount(): number {
    return this.streams.size;
  }
}
