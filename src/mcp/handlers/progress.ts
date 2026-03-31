/**
 * Progress Reporting Utility
 *
 * Creates rate-limited progress reporters using the SDK's native
 * `sendNotification` from `RequestHandlerExtra`. This replaces
 * the redundant RequestManager progress functionality.
 *
 * Rate-limiting prevents flooding the client with too many
 * `notifications/progress` messages during tight loops.
 *
 * @see https://spec.modelcontextprotocol.io/specification/2025-11-25/server/utilities/progress/
 * @module mcp/handlers/progress
 */

import { logger as baseLogger } from "../../logger/index.js";
import type { ProgressData, ProgressReporter, SendNotificationFn, ProgressToken } from "../types/index.js";

const logger = baseLogger.child({ component: "progress" });

const LogMessages = {
  NO_TOKEN: "Progress reporter not created: no progressToken in request _meta",
  RATE_LIMITED: "Progress notification skipped: rate-limited (min interval %dms)",
  SENT: "Progress notification sent: token=%s progress=%d/%s",
  SEND_FAILED: "Progress notification failed (best-effort, ignored): %s",
} as const;

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum interval between progress notifications in milliseconds.
 * Prevents flooding the client with updates during tight loops.
 */
export const PROGRESS_MIN_INTERVAL_MS = 100;

/**
 * MCP notification method for progress updates.
 */
const PROGRESS_METHOD = "notifications/progress" as const;

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a rate-limited progress reporter for a tool invocation.
 *
 * Uses the SDK's native `sendNotification` to send `notifications/progress`
 * messages. Applies rate-limiting (100ms minimum interval) to prevent
 * flooding the client during tight loops.
 *
 * @param sendNotification - The SDK extra's `sendNotification` function
 * @param progressToken - The progress token from `_meta.progressToken` (undefined = no progress requested)
 * @returns A ProgressReporter function, or undefined if no progressToken was provided
 *
 * @example
 * ```typescript
 * // Inside SDK tool callback:
 * const reporter = createProgressReporter(extra.sendNotification, extra._meta?.progressToken);
 *
 * // Use in tool handler:
 * await reporter?.({ progress: 1, total: 10, message: 'Processing...' });
 * ```
 */
export function createProgressReporter(
  sendNotification: SendNotificationFn,
  progressToken: ProgressToken | undefined,
): ProgressReporter | undefined {
  if (progressToken === undefined) {
    logger.trace(LogMessages.NO_TOKEN);
    return undefined;
  }

  let lastNotificationTime = 0;

  return async (data: ProgressData): Promise<boolean> => {
    const now = Date.now();

    // Rate-limit: skip if too soon after last notification
    if (now - lastNotificationTime < PROGRESS_MIN_INTERVAL_MS) {
      logger.trace(LogMessages.RATE_LIMITED, PROGRESS_MIN_INTERVAL_MS);
      return false;
    }

    lastNotificationTime = now;

    try {
      await sendNotification({
        method: PROGRESS_METHOD,
        params: {
          progressToken,
          progress: data.progress,
          ...(data.total !== undefined && { total: data.total }),
          ...(data.message !== undefined && { message: data.message }),
        },
      });
      logger.trace(LogMessages.SENT, progressToken, data.progress, data.total ?? "?");
      return true;
    } catch (error) {
      // Progress notifications are best-effort per MCP specification
      logger.debug(LogMessages.SEND_FAILED, error instanceof Error ? error.message : String(error));
      return false;
    }
  };
}
