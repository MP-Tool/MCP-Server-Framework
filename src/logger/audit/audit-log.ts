/**
 * Audit log — a security/activity trail written to a dedicated file, in parallel to
 * the normal application logs and independent of `LOG_LEVEL`.
 *
 * Audit entries are emitted as one JSON object per line (JSON Lines / NDJSON), which is
 * append-only and trivially machine-parseable for SIEM ingestion. The sink is on by
 * default; the composition root passes the resolved destination and rotation limits via
 * {@link initializeAuditLog} — this module reads no configuration itself, keeping the
 * logger building block free of a config dependency. A write failure disables the sink
 * for the rest of the process (logged once) so call sites can still emit unconditionally
 * without checking.
 *
 * This module deliberately owns its own file stream rather than routing through the
 * application Logger's writers — the audit trail must persist regardless of log level or
 * format and must never be filtered out. Size-based rotation mirrors the `FileWriter`
 * chain (`audit.log` → `audit.log.1` → …), driven by the same `LOG_MAX_FILE_SIZE` /
 * `LOG_MAX_FILES` limits the general file logger uses.
 *
 * @module logger/audit/audit-log
 */

import { createWriteStream, mkdirSync, renameSync, unlinkSync, statSync, type WriteStream } from "node:fs";
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
  /** Rotated files to keep, `audit.log.1` … `audit.log.N` (default: 3). */
  readonly maxFiles?: number | undefined;
}

/** {@link AuditLogOptions} with all defaults applied. */
interface ResolvedAuditLogOptions {
  readonly filePath: string;
  readonly maxSizeBytes: number;
  readonly maxFiles: number;
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
const DEFAULT_MAX_FILES = 3;

/** `undefined` = not yet resolved; `null` = failed to open (I/O error); stream = active. */
let stream: WriteStream | null | undefined;
let warnedWriteError = false;
let sinkOptions: ResolvedAuditLogOptions | undefined;
let bytesWritten = 0;

/** Effective options: explicit init wins; otherwise the documented defaults. */
function resolveOptions(): ResolvedAuditLogOptions {
  return (
    sinkOptions ?? {
      filePath: resolveAuditFilePath(),
      maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
      maxFiles: DEFAULT_MAX_FILES,
    }
  );
}

/** Open the append stream for the configured path, seeding the byte counter. */
function openStream(filePath: string): WriteStream {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
    bytesWritten = statSync(filePath).size;
  } catch {
    bytesWritten = 0; // File doesn't exist yet.
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
  const s = createWriteStream(filePath, { flags: "a" });
  s.on("error", (err) => {
    if (!warnedWriteError) {
      warnedWriteError = true;
      logger.warn("Audit log write error — auditing disabled for this process: %s", err.message);
    }
    // Disable the sink: once the stream has errored (disk full, EPIPE, unlinked inode) it
    // cannot be relied on. Null it so getStream() stops handing back a broken stream and
    // subsequent events become clean no-ops rather than writes into the void. Matches the
    // documented "a write failure disables the sink for the rest of the process".
    stream = null;
  });
  return s;
}

/** Resolve (once) the audit sink. Returns the stream, or null on I/O failure. */
function getStream(): WriteStream | null {
  if (stream !== undefined) return stream;

  const { filePath } = resolveOptions();
  try {
    stream = openStream(filePath);
    logger.info("Audit log enabled: %s", filePath);
    return stream;
  } catch (err) {
    logger.warn(
      "Failed to open audit log %s — auditing disabled: %s",
      filePath,
      err instanceof Error ? err.message : String(err),
    );
    stream = null;
    return null;
  }
}

/**
 * Rotate `audit.log` → `audit.log.1` → … → `audit.log.N`, mirroring the
 * `FileWriter` chain. Synchronous to guarantee ordering; a rotation failure
 * must never break the request path — the sink is reopened or disabled instead.
 */
function rotate(): void {
  const { filePath, maxFiles } = resolveOptions();
  try {
    stream?.destroy();
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- rotation of the trusted audit path
      unlinkSync(`${filePath}.${maxFiles}`);
    } catch {
      // Oldest file may not exist yet.
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- rotation of the trusted audit path
        renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
      } catch {
        // Gaps in the chain are fine.
      }
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- rotation of the trusted audit path
    renameSync(filePath, `${filePath}.1`);
    stream = openStream(filePath);
  } catch (err) {
    logger.warn(
      "Audit log rotation failed — reopening current file: %s",
      err instanceof Error ? err.message : String(err),
    );
    // The old stream is already destroyed — reopen in place, else disable the sink.
    try {
      stream = openStream(filePath);
    } catch {
      stream = null;
    }
  }
}

/**
 * Eagerly opens the audit-log file stream with the given destination and limits.
 *
 * `logAuditEvent()` resolves the stream lazily on first use regardless — calling this is
 * not required for correctness (defaults: `<cwd>/logs/audit.log`, 10 MiB, 3 files). It
 * exists so the composition root can inject the config-resolved path/limits and so the
 * audit file is created (and its path logged) as soon as the server starts — otherwise
 * the file only appears after the first audited event, which reads as "audit logging
 * isn't working" during a quick smoke test. Safe to call more than once; the sink still
 * only resolves once.
 */
export function initializeAuditLog(options?: AuditLogOptions): void {
  if (options && stream === undefined) {
    sinkOptions = {
      filePath: options.filePath,
      maxSizeBytes: options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    };
  }
  getStream();
}

/**
 * Append one audit event to the audit log.
 *
 * A no-op only if the sink failed to open (e.g. permission error) — otherwise always
 * writes, since the audit trail is on by default. Never throws: audit failures must not
 * break the request path; write errors are logged once and otherwise swallowed.
 *
 * @param event - The event to record
 */
export function logAuditEvent(event: AuditEvent): void {
  let s = getStream();
  if (!s) return;

  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    if (bytesWritten > 0 && bytesWritten + line.length > resolveOptions().maxSizeBytes) {
      rotate();
      s = getStream();
      if (!s) return;
    }
    bytesWritten += line.length;
    s.write(line);
  } catch (err) {
    if (!warnedWriteError) {
      warnedWriteError = true;
      logger.warn(
        "Audit serialization error (further errors suppressed): %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Reset the cached sink. Test-only — forces re-resolution on the next event.
 * @internal
 */
export function resetAuditLog(): void {
  if (stream) stream.end();
  stream = undefined;
  sinkOptions = undefined;
  bytesWritten = 0;
  warnedWriteError = false;
}
