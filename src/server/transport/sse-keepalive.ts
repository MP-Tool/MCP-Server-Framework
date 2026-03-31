/**
 * SSE Stream Keepalive
 *
 * Prevents idle SSE streams from being terminated by TCP/proxy idle timeouts.
 * Writes periodic SSE comment lines (`:keepalive`) that are silently discarded
 * by the SSE parser (WHATWG Section 9.2.6) — zero impact on MCP protocol.
 *
 * Used by both Streamable HTTP (GET /mcp) and legacy SSE (GET /sse) transports.
 *
 * @module server/transport/sse-keepalive
 */

import type { Response } from "express";
import { SSE_KEEPALIVE, TRANSPORT_LOG_COMPONENTS } from "./constants.js";
import { logger as baseLogger } from "../../logger/index.js";

const logger = baseLogger.child({ component: TRANSPORT_LOG_COMPONENTS.SSE_KEEPALIVE });

/** @internal */
const LogMessages = {
  KEEPALIVE_STARTED: "SSE keepalive started (interval=%dms)",
  KEEPALIVE_STOPPED: "SSE keepalive stopped",
} as const;

/**
 * Start sending periodic SSE comment keepalives on an open response stream.
 *
 * The returned cleanup function stops the interval. It is safe to call multiple
 * times (idempotent). Cleanup is also registered on `res.on('close')` as a
 * safety net — callers do NOT need to handle the close event separately.
 *
 * @param res - Express Response with an open SSE stream
 * @returns Cleanup function to stop the keepalive interval
 */
export function startSseKeepalive(res: Response): () => void {
  let timer: NodeJS.Timeout | null = setInterval(() => {
    if (res.writableEnded) {
      stop();
      return;
    }
    res.write(SSE_KEEPALIVE.COMMENT);
  }, SSE_KEEPALIVE.INTERVAL_MS);

  // Don't prevent Node.js process from exiting
  timer.unref();

  logger.trace(LogMessages.KEEPALIVE_STARTED, SSE_KEEPALIVE.INTERVAL_MS);

  const stop = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      logger.trace(LogMessages.KEEPALIVE_STOPPED);
    }
  };

  // Safety net: clean up when the stream closes (client disconnect, timeout, etc.)
  res.on("close", stop);

  return stop;
}
