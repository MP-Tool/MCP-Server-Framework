/**
 * Rate limiting middleware
 * Prevents abuse and DoS attacks
 *
 * @module server/middleware/rate-limit
 */

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";
import { TransportErrorMessage, createJsonRpcError, HttpStatus, JsonRpcErrorCode } from "../../errors/index.js";
import { getFrameworkConfig, registerCacheReset } from "../../config/index.js";
import { logger as baseLogger } from "../../logger/index.js";
import { formatDuration } from "../../utils/string-helpers.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "rate-limit";

const LogMessages = {
  CONFIGURED: "Rate limiter configured: max %d requests per %s window",
  EXCEEDED: "Rate limit exceeded from %s",
  TRUST_PROXY_MISSING:
    "X-Forwarded-For header detected but MCP_TRUST_PROXY is not configured — " +
    "all clients behind the reverse proxy share a single rate-limit bucket. " +
    "Configure MCP_TRUST_PROXY for correct per-client rate limiting.",
  PROXY_REJECTED: "Rejected proxied request from %s — MCP_TRUST_PROXY not configured",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

/**
 * Rate limiter configuration options.
 */
export interface RateLimiterOptions {
  /** Time window in milliseconds (default: 900000 = 15 minutes) */
  windowMs?: number;
  /** Maximum requests per window (default: 1000) */
  max?: number;
  /**
   * Whether Express trust proxy is configured.
   *
   * When `true`, the rate limiter uses `req.ip` (correctly resolved by Express
   * via `X-Forwarded-For`). When `false` and `X-Forwarded-For` is detected,
   * all clients behind the proxy share a single rate-limit bucket
   * (keyed by proxy IP), and a one-time warning is logged.
   */
  trustProxyConfigured?: boolean;
}

/** Cached rate limiter instance (lazy initialization) */
let cachedRateLimiter: RateLimitRequestHandler | undefined;

// Self-register for central cache reset
registerCacheReset(resetRateLimiterCache);

/**
 * Resets the cached rate limiter.
 * Called by the central config reset to maintain cache coherence.
 *
 * @internal
 */
export function resetRateLimiterCache(): void {
  cachedRateLimiter = undefined;
}

/**
 * Creates or returns cached rate limiter for MCP endpoint.
 *
 * Uses lazy initialization to avoid circular dependency issues.
 * The config is read when the function is first called, not at module load.
 *
 * Configurable via environment variables:
 * - MCP_RATE_LIMIT_WINDOW_MS: Time window in ms (default: 900000 = 15 minutes)
 * - MCP_RATE_LIMIT_MAX: Max requests per window (default: 1000)
 *
 * @param options - Optional override for rate limit settings
 * @returns Express rate limiter middleware
 */
export function createRateLimiter(options?: RateLimiterOptions): RateLimitRequestHandler {
  if (cachedRateLimiter && !options) {
    return cachedRateLimiter;
  }

  // Lazy load config to avoid circular dependency
  const config = getFrameworkConfig();

  const windowMs = options?.windowMs ?? config.MCP_RATE_LIMIT_WINDOW_MS;
  const max = options?.max ?? config.MCP_RATE_LIMIT_MAX;

  // Trust proxy warning: detect reverse proxy without trust proxy config.
  // Without trust proxy, req.ip is the TCP connection IP (proxy IP) — not spoofable,
  // but all clients behind the same proxy share one rate-limit bucket.
  // This is the safest default: a custom keyGenerator using X-Forwarded-For would
  // allow attackers to create unlimited buckets by spoofing the header.
  const trustProxyActive = options?.trustProxyConfigured ?? false;
  let trustProxyWarningLogged = false;

  const limiter = rateLimit({
    windowMs,
    max,
    message: TransportErrorMessage.RATE_LIMIT_EXCEEDED,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req, res) => {
      // Log one-time warning when X-Forwarded-For detected without trust proxy
      if (!trustProxyActive && !trustProxyWarningLogged && req.headers["x-forwarded-for"]) {
        logger.warn(LogMessages.TRUST_PROXY_MISSING);
        trustProxyWarningLogged = true;
      }
      logger.warn(LogMessages.EXCEEDED, req.ip ?? "unknown");
      res
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.RATE_LIMIT_EXCEEDED));
    },
  });

  logger.debug(LogMessages.CONFIGURED, max, formatDuration(windowMs));

  // When trust proxy is not configured, reject requests that arrive via a reverse proxy.
  // Without trust proxy, req.ip resolves to the proxy IP — rate limiting and IP-based
  // security would apply to the proxy, not individual clients. Reject with 502 so the
  // operator notices the misconfiguration.
  if (!trustProxyActive) {
    const guardedLimiter = ((req: Request, res: Response, next: NextFunction) => {
      if (req.headers["x-forwarded-for"]) {
        logger.warn(LogMessages.PROXY_REJECTED, req.ip ?? "unknown");
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.PROXY_NOT_CONFIGURED));
        return;
      }
      limiter(req, res, next);
    }) as RateLimitRequestHandler;

    if (!options) {
      cachedRateLimiter = guardedLimiter;
    }
    return guardedLimiter;
  }

  if (!options) {
    cachedRateLimiter = limiter;
  }

  return limiter;
}
