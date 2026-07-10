/**
 * Audit log — a security/activity trail written to a dedicated file, in parallel to
 * the normal application logs and independent of `LOG_LEVEL`.
 *
 * Audit entries are emitted as one JSON object per line (JSON Lines / NDJSON), which is
 * append-only and trivially machine-parseable for SIEM ingestion. The sink is on by
 * default — `MCP_AUDIT_FILE` (or `[logging].audit_file`) overrides the destination, but
 * even when unset, events land in `<LOG_DIR or the default log dir>/audit.log`
 * (see {@link resolveAuditFilePath}). A write failure disables the sink for the rest of
 * the process (logged once) so call sites can still emit unconditionally without checking.
 *
 * This module deliberately owns its own file stream rather than routing through the
 * application Logger's writers — the audit trail must persist regardless of log level or
 * format and must never be filtered out. It lives at the infrastructure layer (alongside
 * `logger`/`telemetry`) so both the `mcp` and `server` layers may emit events.
 *
 * @module audit/audit-log
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { getFrameworkConfig } from "../config/index.js";
import { resolveAuditFilePath } from "../config/env.js";
import { logger as baseLogger } from "../logger/index.js";

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

// ============================================================================
// Sink
// ============================================================================

/** `undefined` = not yet resolved; `null` = failed to open (I/O error); stream = active. */
let stream: WriteStream | null | undefined;
let warnedWriteError = false;

/** Resolve (once) the audit sink from config. Returns the stream, or null on I/O failure. */
function getStream(): WriteStream | null {
  if (stream !== undefined) return stream;

  const filePath = resolveAuditFilePath(getFrameworkConfig());

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
    mkdirSync(dirname(filePath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path from trusted server config
    const s = createWriteStream(filePath, { flags: "a" });
    s.on("error", (err) => {
      if (!warnedWriteError) {
        warnedWriteError = true;
        logger.warn("Audit log write error (further errors suppressed): %s", err.message);
      }
    });
    stream = s;
    logger.info("Audit log enabled: %s", filePath);
    return s;
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
 * Eagerly opens the audit-log file stream.
 *
 * `logAuditEvent()` resolves the stream lazily on first use regardless — calling this is
 * not required for correctness. It exists so the audit file is created (and its path
 * logged) as soon as the server starts, matching the framework's general file logger
 * (`configureLogger()`'s `FileWriter` opens its streams eagerly too) — otherwise the
 * audit file only appears after the first tool call / session / security event, which
 * reads as "audit logging isn't working" during a quick smoke test. Safe to call more
 * than once; the sink still only resolves once.
 */
export function initializeAuditLog(): void {
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
  const s = getStream();
  if (!s) return;

  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    s.write(line + "\n");
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
 * Reset the cached sink. Test-only — forces re-resolution from config on the next event.
 * @internal
 */
export function resetAuditLog(): void {
  if (stream) stream.end();
  stream = undefined;
  warnedWriteError = false;
}
