/**
 * Audit log — a security/activity trail written to a dedicated file, in parallel to
 * the normal application logs and independent of `LOG_LEVEL`.
 *
 * Audit entries are emitted as one JSON object per line (JSON Lines / NDJSON), which is
 * append-only and trivially machine-parseable for SIEM ingestion. The sink is on by
 * default; the composition root passes the resolved destination and size limit via
 * {@link initializeAuditLog} — this module reads no configuration itself, keeping the
 * logger building block free of a config dependency.
 *
 * This module deliberately owns its own file rather than routing through the application
 * Logger's writers — the audit trail must persist regardless of log level or format and
 * must never be filtered out. Its contract is that no record gets lost:
 *
 * - Writes are synchronous, so a record is with the OS when {@link logAuditEvent} returns;
 *   there is no buffer for a crash or a rotation to drop.
 * - Rotated files get a timestamped name and are never deleted (`LOG_MAX_FILES` applies to
 *   the application logs only). Removing old audit files is the operator's decision. A flood
 *   of audited events therefore costs disk space, not records.
 * - A failing file never disables the trail: the record goes to stderr and the next event
 *   tries the file again.
 *
 * @module logger/audit/audit-log
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger as baseLogger } from "../logger.js";

const logger = baseLogger.child({ component: "audit" });

// ============================================================================
// Types
// ============================================================================

/** Coarse grouping for an audit event. Open-ended so consumers can add domains. */
export type AuditCategory = "auth" | "session" | "tool" | "permission" | "config" | (string & {});

/** Outcome of the audited action. */
export type AuditOutcome = "success" | "failure" | "denied" | "info";

/** Who performed the action (as much as is known at the call site). */
export interface AuditActor {
  /** Stable principal id (e.g. the downstream user id used for session isolation). */
  readonly userId?: string | undefined;
  /** Human-readable identity for the trail (e.g. username / email). */
  readonly username?: string | undefined;
  /** MCP session id the action belongs to. */
  readonly sessionId?: string | undefined;
  /** Client IP, when available. */
  readonly ip?: string | undefined;
}

/** A single audit trail entry. Serialized to one JSON line with a `ts` timestamp. */
export interface AuditEvent {
  /** Coarse category, e.g. `auth` | `session` | `tool` | `permission` | `config`. */
  readonly category: AuditCategory;
  /** Specific action, e.g. `login` | `session.open` | `tool.call` | `permission.denied`. */
  readonly action: string;
  /** Result of the action. */
  readonly outcome: AuditOutcome;
  /**
   * Correlation id tying together all events of one request (e.g. the MCP JSON-RPC
   * request id). Lets a tool call and its `permission.*` / `confirmation.*` events be
   * stitched back into a single trail.
   */
  readonly requestId?: string | undefined;
  /** Acting principal. */
  readonly actor?: AuditActor | undefined;
  /** Affected target (e.g. tool name, `Server:abc123`). */
  readonly target?: string | undefined;
  /** Free-form structured detail (caller is responsible for scrubbing secrets). */
  readonly detail?: Record<string, unknown> | undefined;
}

/** Sink configuration, resolved by the composition root from framework config. */
export interface AuditLogOptions {
  /** Destination file. See {@link resolveAuditFilePath} for the standard resolution. */
  readonly filePath: string;
  /** Rotate when the file exceeds this size in bytes (default: 10 MiB). */
  readonly maxSizeBytes?: number | undefined;
}

/** {@link AuditLogOptions} with all defaults applied. */
interface ResolvedAuditLogOptions {
  readonly filePath: string;
  readonly maxSizeBytes: number;
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolves the effective audit-log file path from the already-resolved logging
 * settings: an explicit audit file wins; otherwise the trail lands in
 * `<logDir>/audit.log`, following wherever general file logging goes.
 *
 * @param logDir - Resolved log directory (defaults to `<cwd>/logs`, the same
 *   convention the general file logger uses)
 * @param auditFile - Explicit audit-file override, when configured
 * @returns An always-usable, non-empty audit-log file path
 */
export function resolveAuditFilePath(logDir?: string, auditFile?: string): string {
  return auditFile ?? join(logDir ?? join(process.cwd(), "logs"), "audit.log");
}

// ============================================================================
// Sink
// ============================================================================

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Marks a record on stderr, where it shares the stream with other output. */
const STDERR_PREFIX = "[audit] ";

/** Open file descriptor, or `null` while closed; every event retries a closed file. */
let fd: number | null = null;
let bytesWritten = 0;
let sinkOptions: ResolvedAuditLogOptions | undefined;
/** Whether the file is currently failing, so an outage is logged once, not per record. */
let failing = false;
let rotationFailing = false;
let announcedPath: string | undefined;

/** Effective options: explicit init wins; otherwise the documented defaults. */
function resolveOptions(): ResolvedAuditLogOptions {
  return sinkOptions ?? { filePath: resolveAuditFilePath(), maxSizeBytes: DEFAULT_MAX_SIZE_BYTES };
}

function noteFailure(err: unknown): void {
  if (failing) return;
  failing = true;
  logger.warn(
    "Audit log unavailable — records go to stderr until it recovers: %s",
    err instanceof Error ? err.message : String(err),
  );
}

function closeFile(): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // Already unusable; the next event reopens.
  }
  fd = null;
}

/** The open file, opening it if needed; `null` when that fails right now. */
function ensureOpen(): number | null {
  if (fd !== null) return fd;
  const { filePath } = resolveOptions();
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
    mkdirSync(dirname(filePath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
    fd = openSync(filePath, "a");
    bytesWritten = fstatSync(fd).size;
  } catch (err) {
    closeFile();
    noteFailure(err);
    return null;
  }
  if (failing) {
    failing = false;
    logger.warn("Audit log recovered: %s", filePath);
  } else if (announcedPath !== filePath) {
    logger.info("Audit log enabled: %s", filePath);
  }
  announcedPath = filePath;
  return fd;
}

/** A name no rotated file has yet: `audit.log.20261102T101530Z`, then `-1`, `-2`, ... */
function rotatedPath(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  let candidate = `${filePath}.${stamp}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- rotation of the trusted audit path
  for (let n = 1; existsSync(candidate); n++) candidate = `${filePath}.${stamp}-${n}`;
  return candidate;
}

/**
 * Move the full file aside under a new name. If that fails the current file simply keeps growing:
 * an oversized file is a smaller problem than a lost record.
 */
function rotate(): void {
  const { filePath } = resolveOptions();
  closeFile();
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- rotation of the trusted audit path
    renameSync(filePath, rotatedPath(filePath));
    rotationFailing = false;
  } catch (err) {
    if (!rotationFailing) {
      rotationFailing = true;
      logger.warn(
        "Audit log rotation failed — current file keeps growing: %s",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Eagerly opens the audit-log file with the given destination and size limit.
 *
 * `logAuditEvent()` opens the file on first use regardless — calling this is not required
 * for correctness (defaults: `<cwd>/logs/audit.log`, 10 MiB). It exists so the composition
 * root can inject the config-resolved path/limit and so the audit file is created (and its
 * path logged) as soon as the server starts — otherwise the file only appears after the
 * first audited event, which reads as "audit logging isn't working" during a quick smoke test.
 *
 * The configured destination always wins: a file lazily opened at the default path during
 * bootstrap is closed and the next open uses the configured `filePath`.
 */
export function initializeAuditLog(options?: AuditLogOptions): void {
  if (options) {
    if (sinkOptions?.filePath !== options.filePath) closeFile();
    sinkOptions = {
      filePath: options.filePath,
      maxSizeBytes: options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    };
  }
  ensureOpen();
}

/** One JSON line; a value that cannot be serialized costs the detail, not the record. */
function serialize(event: AuditEvent): string {
  const ts = new Date().toISOString();
  try {
    return `${JSON.stringify({ ts, ...event })}\n`;
  } catch (err) {
    const { category, action, outcome, requestId, target } = event;
    const detailError = err instanceof Error ? err.message : String(err);
    return `${JSON.stringify({ ts, category, action, outcome, requestId, target, detailError })}\n`;
  }
}

function writeToStderr(line: string): void {
  try {
    process.stderr.write(STDERR_PREFIX + line);
  } catch {
    // Nowhere left to write; audit failures must not break the request path.
  }
}

/**
 * Append one audit event to the audit log, durably: see the module description.
 * Never throws — audit failures must not break the request path.
 *
 * @param event - The event to record
 */
export function logAuditEvent(event: AuditEvent): void {
  const line = serialize(event);
  const data = Buffer.from(line);

  if (ensureOpen() !== null && bytesWritten > 0 && bytesWritten + data.length > resolveOptions().maxSizeBytes) {
    rotate();
  }
  const target = ensureOpen();
  if (target === null) {
    writeToStderr(line);
    return;
  }

  try {
    for (let offset = 0; offset < data.length; ) {
      offset += writeSync(target, data, offset);
    }
    bytesWritten += data.length;
  } catch (err) {
    noteFailure(err);
    closeFile();
    writeToStderr(line);
  }
}

/**
 * Reset the sink. Test-only — forces re-resolution on the next event.
 * @internal
 */
export function resetAuditLog(): void {
  closeFile();
  sinkOptions = undefined;
  bytesWritten = 0;
  failing = false;
  rotationFailing = false;
  announcedPath = undefined;
}
