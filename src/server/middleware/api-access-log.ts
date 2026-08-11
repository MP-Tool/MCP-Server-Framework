/**
 * API Access Log middleware
 *
 * Logs one line per HTTP request/response (method, path, status, duration) to the
 * framework's "api" file-log component. This is an operational access log, distinct
 * from the audit trail (`logAuditEvent`) — it covers ALL traffic including health
 * checks and rejected requests, which would flood the audit trail with low-value
 * noise if mirrored there too.
 *
 * @module server/middleware/api-access-log
 */

import type { Request, Response, NextFunction } from "express";
import { logger as baseLogger } from "../../logger/index.js";
import { withExtendedContext } from "../../logger/core/context.js";
import { MCP_HEADERS } from "../transport/constants.js";
import { truncateForLog } from "./logging.js";

const logger = baseLogger.child({ component: "api" });

/** @internal Log messages for the API access log */
const LogMessages = {
  REQUEST_COMPLETED: "%s %s %d (%dms)",
} as const;

/**
 * Pick the log level for a completed request. Routine, low-signal traffic —
 * CORS `OPTIONS` preflights, `.well-known/*` discovery probes, and `3xx`
 * redirects/not-modified — is demoted to `debug` so the `info` access log
 * shows substantive calls and errors (`4xx`/`5xx` stay `info`).
 *
 * @internal exported for unit testing.
 */
export function levelFor(method: string, path: string, statusCode: number): "info" | "debug" {
  // Errors are always visible, even on an otherwise-routine preflight or discovery probe.
  if (statusCode >= 400) return "info";
  if (method === "OPTIONS" || path.startsWith("/.well-known/") || statusCode >= 300) return "debug";
  return "info";
}

/**
 * Logs every HTTP request on completion.
 *
 * Must be mounted first in the Express pipeline (before security middleware) so
 * `res.on("finish")` is registered before anything else runs — requests rejected
 * later (DNS rebinding, auth, rate limiting) are still captured here.
 */
export function apiAccessLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  const method = req.method;
  // Path only — never the query string. OAuth flows carry `code`/`state` in query
  // params (/authorize, /callback); logging them would leak sensitive values.
  const path = truncateForLog(req.path);
  const sessionHeader = req.headers[MCP_HEADERS.SESSION_ID];
  const rawSessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  // Client-supplied header — length-bound it like every other transport log site so an
  // oversized (up to ~16 KB) attacker value can't bloat the log context.
  const sessionId = rawSessionId === undefined ? undefined : truncateForLog(rawSessionId);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const statusCode = res.statusCode;

    withExtendedContext(
      {
        http: { method, path, statusCode, durationMs },
        ...(sessionId !== undefined && { sessionId }),
      },
      () => {
        logger[levelFor(method, path, statusCode)](LogMessages.REQUEST_COMPLETED, method, path, statusCode, durationMs);
      },
    );
  });

  next();
}
