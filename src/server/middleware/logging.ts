/**
 * Security logging utilities for transport middleware
 *
 * @module server/middleware/logging
 */

import { logger as baseLogger } from "../../logger/index.js";
import { logAuditEvent } from "../../logger/audit/index.js";
import { TRANSPORT_LOG_COMPONENTS } from "../transport/constants.js";

const logger = baseLogger.child({
  component: TRANSPORT_LOG_COMPONENTS.SECURITY,
});

/** @internal Log messages for transport logging utilities. The `[Security]` component tag
 * already conveys the category — no redundant "Security:" prefix in the message. */
const LogMessages = {
  SECURITY_EVENT: "%s",
} as const;

/**
 * Maximum length of an untrusted value embedded in a log message. Long enough to keep
 * diagnostics useful (hostnames, headers, paths), short enough that an attacker cannot
 * pad the log with megabytes of junk per request.
 */
const MAX_LOG_INPUT_LENGTH = 200;

/**
 * Trims and length-bounds untrusted input before it is embedded in a log message.
 *
 * This is a length/whitespace clamp only — it deliberately does NOT perform CWE-117
 * control-character escaping. That is applied automatically downstream by the Logger
 * pipeline's `InjectionGuard` (see `sanitizeForLogging` in `logger/injection-guard`);
 * pre-escaping here would double-escape (e.g. backslashes re-escaped). The two are
 * complementary despite the similar-sounding names: this bounds size, that neutralizes
 * injection characters.
 */
export function truncateForLog(input: string | undefined | null): string {
  if (!input) return "";
  return input.trim().slice(0, MAX_LOG_INPUT_LENGTH);
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
