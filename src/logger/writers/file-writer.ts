/**
 * File Log Writer Module
 *
 * Writes log entries to files organized by component.
 * Handles stream creation, directory management, and graceful shutdown.
 *
 * @module logger/writers/file-writer
 */

/* eslint-disable security/detect-non-literal-fs-filename -- all paths derive from the trusted log
   directory (config/env) joined with a fixed, sanitized component name; never from request input. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LogLevel } from "../core/types.js";
import { DEFAULT_LOG_COMPONENTS, LOG_FILE_EXTENSION } from "../core/constants.js";
import { BaseLogWriter } from "./base-writer.js";

/**
 * Configuration for the file writer.
 */
export interface FileWriterConfig {
  /** Directory to write log files to */
  logDir: string;
  /** Component names to create streams for (default: ['server', 'api']) */
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

  /**
   * Components this writer is allowed to (re)create a stream for — the configured
   * components plus the fallback. Bounds self-healing to known, intentional log files;
   * an unrecognized component string never spontaneously gets its own file.
   */
  private readonly knownComponents: Set<string> = new Set();
  /** Last failed recreate attempt per component, for the self-heal throttle in write(). */
  private readonly lastFailedAttempt: Map<string, number> = new Map();
  /** Components currently missing a stream that have already been warned about on stderr. */
  private readonly warnedComponents: Set<string> = new Set();

  /** Default max file size: 10 MB */
  private static readonly DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
  /** Default max rotated files to keep */
  private static readonly DEFAULT_MAX_FILES = 3;
  /** Retention cleanup interval: once per day */
  private static readonly RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  /**
   * Minimum time between self-heal stream-recreate attempts for the same component.
   * Bounds retry cost when the underlying filesystem is persistently unavailable —
   * without this, a broken disk would trigger a fresh createWriteStream()+statSync()
   * syscall pair on every single log line.
   */
  private static readonly RETRY_MIN_INTERVAL_MS = 1000;

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

    const components = config.components ?? DEFAULT_LOG_COMPONENTS;
    for (const component of components) this.knownComponents.add(this.safeComponent(component));
    this.knownComponents.add(this.safeComponent(this.fallbackComponent));

    this.initialize(components);
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
   *
   * Safe to call repeatedly as a recovery primitive (used both at startup and by write()'s
   * self-heal path) — re-ensures the log directory exists each time, since the most common
   * cause of a stream going bad (the directory being removed) needs that regardless of caller.
   */
  private createStream(component: string): boolean {
    // Key everything by the sanitized name so two raw component names that sanitize to the
    // same file (e.g. `a/b` and `a_b`) share one stream instead of two streams racing on
    // one file with split byte-accounting.
    component = this.safeComponent(component);
    if (this.streams.has(component)) {
      return true;
    }

    try {
      fs.mkdirSync(this.logDir, { recursive: true });

      const filePath = this.getFilePath(component);
      const stream = fs.createWriteStream(filePath, { flags: "a" });

      // Handle stream errors to prevent unhandled exceptions. Recovery is not attempted here —
      // it happens uniformly via write()'s self-heal path on the next log call, throttled by
      // RETRY_MIN_INTERVAL_MS so a persistently broken filesystem doesn't retry on every line.
      //
      // Most real failure modes (ENOENT, EACCES, EISDIR, disk full) surface here — the actual
      // file open happens off-thread, so createWriteStream() itself returns synchronously
      // without throwing. Recording the throttle timestamp here (not only in tryRecreateStream's
      // synchronous catch) is what makes the throttle effective for these — otherwise a stream
      // that "succeeds" synchronously but errors moments later would let every write() in
      // between synchronously reuse the doomed stream, then each immediately retry on the next
      // call once it's gone, with no throttle ever engaging.
      stream.on("error", (err: NodeJS.ErrnoException) => {
        this.streams.delete(component);
        this.lastFailedAttempt.set(component, Date.now());
        this.warnOnce(component, `Stream error for ${component}: ${err.message}`);
      });

      this.streams.set(component, stream);

      // Initialize byte counter from existing file size (for rotation accuracy after restart)
      try {
        const stats = fs.statSync(filePath);
        this.bytesWritten.set(component, stats.size);
      } catch {
        this.bytesWritten.set(component, 0);
      }

      // Recovered — allow a future failure to be warned about again.
      this.warnedComponents.delete(component);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.warnOnce(component, `Failed to create stream for ${component}: ${message}`);
      return false;
    }
  }

  /**
   * Log a stderr diagnostic for a component's stream failure, once per outage episode.
   * Cleared on the next successful createStream() so a later, separate failure is still
   * reported rather than being silenced forever by an earlier warning.
   */
  private warnOnce(component: string, message: string): void {
    if (this.warnedComponents.has(component)) return;
    this.warnedComponents.add(component);
    process.stderr.write(`[FileWriter] ${message}\n`);
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

    // Resolve the stream for the requested component. Normalize first so the lookup key
    // matches how streams were registered in createStream(). If it's missing but known
    // (a prior init/runtime failure), self-heal by retrying — restores the component's own
    // file once the underlying issue clears, instead of silently commingling its lines into
    // the fallback file forever after one transient blip.
    const safe = this.safeComponent(component);
    let effectiveComponent = safe;
    let stream = this.streams.get(safe) ?? (this.knownComponents.has(safe) ? this.tryRecreateStream(safe) : undefined);

    if (!stream) {
      // Requested component unavailable (unknown component, or recreate failed) — fall back.
      effectiveComponent = this.safeComponent(this.fallbackComponent);
      stream = this.streams.get(effectiveComponent) ?? this.tryRecreateStream(effectiveComponent);
    }

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

  /**
   * Throttled self-heal: retries {@link createStream} for a component whose stream is
   * currently missing, at most once per {@link FileWriter.RETRY_MIN_INTERVAL_MS}. Returns the
   * live stream on success, or `undefined` if recreation failed or was skipped by the throttle.
   */
  private tryRecreateStream(component: string): fs.WriteStream | undefined {
    const now = Date.now();
    const last = this.lastFailedAttempt.get(component);
    if (last !== undefined && now - last < FileWriter.RETRY_MIN_INTERVAL_MS) {
      return undefined;
    }

    if (this.createStream(component)) {
      this.lastFailedAttempt.delete(component);
      return this.streams.get(component);
    }

    this.lastFailedAttempt.set(component, now);
    return undefined;
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
        this.streams.delete(component);
        // Detach the self-heal error handler before the intentional destroy: a still-buffered
        // write aborted by destroy() surfaces asynchronously as ERR_STREAM_DESTROYED, and that
        // late event would otherwise (a) log a spurious stderr "Stream error" and (b) delete the
        // freshly-created replacement stream (step 5) from the map — its handler is keyed by
        // component. Swallow errors on the discarded stream instead.
        oldStream.removeAllListeners("error");
        oldStream.on("error", () => {});
        oldStream.destroy();
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

    // Only ever delete THIS writer's own files. `LOG_DIR` is shared: the audit trail
    // (`audit.log`), other writers, and third-party files can live in the same directory,
    // so a blanket `*.<ext>` sweep by mtime would silently unlink a quiet-but-live
    // audit.log (its open append fd then writes to a deleted inode). Scope the sweep to
    // each known component's base file + its rotated variants.
    const ownFiles = new Set<string>();
    for (const component of this.streams.keys()) {
      // streams are already keyed by the sanitized name, but re-apply for safety.
      const safeName = this.safeComponent(component);
      ownFiles.add(`${safeName}${this.extension}`);
      for (let n = 1; n <= this.maxFiles; n++) {
        ownFiles.add(`${safeName}.${n}${this.extension}`);
      }
    }

    for (const entry of ownFiles) {
      const filePath = path.join(this.logDir, entry);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // best-effort: missing file / individual errors are non-fatal
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Path Helpers
  // ---------------------------------------------------------------------------

  /**
   * Sanitize a component name into a filesystem-safe basename. Also blocks path traversal
   * via component names (`../../x` → `______x`). Idempotent — safe names pass through.
   */
  private safeComponent(component: string): string {
    return component.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  /** Build the primary log file path for a component. */
  private getFilePath(component: string): string {
    return path.join(this.logDir, `${this.safeComponent(component)}${this.extension}`);
  }

  /** Build the rotated file path: `<component>.<n><extension>` */
  private getRotatedPath(component: string, n: number): string {
    return path.join(this.logDir, `${this.safeComponent(component)}.${n}${this.extension}`);
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
    this.knownComponents.add(this.safeComponent(component));
    return this.createStream(component);
  }

  /**
   * Get the number of active streams.
   */
  getStreamCount(): number {
    return this.streams.size;
  }
}
