/**
 * Security logging utilities for transport middleware
 *
 * @module server/middleware/logging
 */

import { logger as baseLogger } from "../../logger/index.js";
import { logAuditEvent } from "../../audit/index.js";
import { TRANSPORT_LOG_COMPONENTS } from "../transport/constants.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.SECURITY,
});

/** @internal Log messages for transport logging utilities */
const LogMessages = {
  SECURITY_EVENT: "Security: %s",
} as const;

/**
 * Truncates and trims untrusted input for safe inclusion in log messages.
 *
 * Does NOT apply CWE-117 escaping here — the Logger pipeline applies
 * InjectionGuard.sanitize() automatically. Pre-sanitizing would cause
 * double-escaping (e.g., backslashes being re-escaped).
 */
export function sanitizeForLog(input: string | undefined | null): string {
  if (!input) return "";
  return input.trim().slice(0, 200);
}

/**
 * Logs security events with consistent formatting.
 *
 * @param event - Security event description
 * @param details - Optional context for the event
 */
export function logSecurityEvent(event: string, details?: unknown): void {
  logger.warn(LogMessages.SECURITY_EVENT, event, details || "");
  // Mirror to the audit trail (no-op when no audit file is configured).
  logAuditEvent({
    category: "auth",
    action: "security_event",
    outcome: "denied",
    detail: {
      event,
      ...(details !== undefined && typeof details === "object" && details !== null
        ? (details as Record<string, unknown>)
        : details !== undefined
          ? { details }
          : {}),
    },
  });
}
