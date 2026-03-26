/**
 * Health and Readiness check routes
 *
 * Provides endpoints for container orchestration (Kubernetes, Docker Swarm, Docker Compose):
 *
 * /health - Liveness probe (is the process alive?)
 *   - Always returns 200 if server is running
 *   - Use: Kubernetes livenessProbe, basic uptime monitoring
 *
 * /ready - Readiness probe (can the server handle requests?)
 *   - 200 OK: Server is ready for traffic
 *   - 503 Service Unavailable: API configured but not connected
 *   - 429 Too Many Requests: Session limit reached
 *   - Use: Kubernetes readinessProbe, Docker HEALTHCHECK, load balancer health checks
 *
 * For Docker containers, use /ready as the HEALTHCHECK endpoint to ensure
 * the container only receives traffic when fully operational.
 *
 * @module server/routes/health
 */

import { Router } from "express";
import type { SessionManager } from "../session/index.js";
import { getFrameworkConfig } from "../../config/index.js";
import { logger as baseLogger } from "../../logger/index.js";

// ============================================================================
// Constants
// ============================================================================

const ROUTES = {
  HEALTH: "/health",
  READY: "/ready",
} as const;

const LOG_COMPONENT = "health";

const LogMessages = {
  NOT_READY: "Server not ready: %s",
  READINESS_CHECK: "Readiness check: status=%d, reason=%s",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Types
// ============================================================================

import { ReadinessStatus, type ReadinessStatusValue } from "./readiness-status.js";
export { ReadinessStatus, type ReadinessStatusValue } from "./readiness-status.js";

/**
 * SSE transport information provider.
 *
 * Injected by the transport layer to decouple health checks
 * from SSE implementation details.
 */
export interface SseInfoProvider {
  /** Whether SSE transport is enabled */
  readonly enabled: boolean;
  /** Get the current count of active SSE sessions */
  getSessionCount(sessionManager: SessionManager): number;
}

/**
 * Options for creating the health router.
 */
export interface HealthRouterOptions {
  /** Session manager for tracking active sessions */
  sessionManager: SessionManager;

  /**
   * Custom readiness check. Called on every `GET /ready` request.
   * - Return `true` (or `undefined`/no check configured) → 200 (ready)
   * - Return `false` → 503 (not ready)
   * - Return a `string` → 503 with the string as reason
   */
  readinessCheck?: (() => boolean | string | Promise<boolean | string>) | undefined;

  /**
   * Label for the service in health responses.
   * @default 'service'
   */
  serviceLabel?: string | undefined;

  /**
   * Optional SSE transport information.
   * If not provided, SSE-related information is omitted from health responses.
   */
  sseInfo?: SseInfoProvider | undefined;
}

// ============================================================================
// Health Router Factory
// ============================================================================

/**
 * Creates health check router with configurable readiness checks.
 *
 * @param options - Configuration options for the health router
 * @returns Express router with /health and /ready endpoints
 *
 * @example
 * ```typescript
 * // Basic usage (no readiness check)
 * const router = createHealthRouter({ sessionManager });
 *
 * // With custom readiness check
 * const router = createHealthRouter({
 *   sessionManager,
 *   readinessCheck: async () => {
 *     const ok = await myApi.ping();
 *     return ok || 'API not reachable';
 *   },
 *   serviceLabel: 'my-api',
 * });
 * ```
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
  const { sessionManager, readinessCheck, serviceLabel = "service", sseInfo } = options;

  const router = Router();

  /**
   * Liveness probe endpoint
   * Returns 200 if the server process is running.
   */
  router.get(ROUTES.HEALTH, (_req, res) => {
    const config = getFrameworkConfig();

    res.status(200).json({
      status: "healthy",
      version: config.VERSION,
      uptime: process.uptime(),
    });
  });

  /**
   * Readiness probe endpoint
   * Returns appropriate status code based on server readiness.
   */
  router.get(ROUTES.READY, async (_req, res) => {
    const config = getFrameworkConfig();

    // Read session limits from dynamic config
    const maxSessions = config.MCP_MAX_SESSIONS;
    const maxStreamableHttpSessions = config.MCP_MAX_STREAMABLE_HTTP_SESSIONS;
    const maxSseSessions = config.MCP_MAX_SSE_SESSIONS;

    // Check session limits using accurate per-transport-type counters
    const { byTransportType } = sessionManager.stats;
    const totalSessionCount = sessionManager.size;
    const sseEnabled = sseInfo?.enabled ?? false;
    const sseSessionCount = byTransportType.sse;
    const streamableHttpSessionCount = byTransportType.http + byTransportType.https;
    const totalAtLimit = totalSessionCount >= maxSessions;
    const streamableHttpAtLimit = streamableHttpSessionCount >= maxStreamableHttpSessions;
    const sseAtLimit = sseEnabled && sseSessionCount >= maxSseSessions;
    const sessionsAtLimit = totalAtLimit || streamableHttpAtLimit || sseAtLimit;

    // Determine status code
    let status: ReadinessStatusValue;
    let reason: string;

    if (sessionsAtLimit) {
      status = ReadinessStatus.TOO_MANY_REQUESTS;
      if (totalAtLimit) {
        reason = `Total session limit reached (${totalSessionCount}/${maxSessions})`;
      } else if (streamableHttpAtLimit) {
        reason = `Streamable HTTP session limit reached (${streamableHttpSessionCount}/${maxStreamableHttpSessions})`;
      } else {
        reason = `SSE session limit reached (${sseSessionCount}/${maxSseSessions})`;
      }
    } else if (readinessCheck) {
      // Run consumer-provided readiness check
      try {
        const result = await readinessCheck();
        if (result === true) {
          status = ReadinessStatus.READY;
          reason = "Server is ready";
        } else if (result === false) {
          status = ReadinessStatus.SERVICE_UNAVAILABLE;
          reason = `${serviceLabel} not ready`;
        } else {
          // string → 503 with custom reason
          status = ReadinessStatus.SERVICE_UNAVAILABLE;
          reason = result;
        }
      } catch (err) {
        status = ReadinessStatus.SERVICE_UNAVAILABLE;
        reason = `${serviceLabel} readiness check failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      status = ReadinessStatus.READY;
      reason = "Server is ready";
    }

    const isReady = status === ReadinessStatus.READY;

    // Log readiness state — warn on not-ready, debug on ready
    if (!isReady) {
      logger.warn(LogMessages.NOT_READY, reason);
    } else {
      logger.debug(LogMessages.READINESS_CHECK, status, reason);
    }

    const response: Record<string, unknown> = {
      ready: isReady,
      status: reason,
      version: config.VERSION,
      uptime: process.uptime(),
      sessions: {
        total: {
          current: totalSessionCount,
          max: maxSessions,
          atLimit: totalAtLimit,
        },
        streamableHttp: {
          current: streamableHttpSessionCount,
          max: maxStreamableHttpSessions,
          atLimit: streamableHttpAtLimit,
        },
        ...(sseEnabled && {
          sse: {
            current: sseSessionCount,
            max: maxSseSessions,
            atLimit: sseAtLimit,
          },
        }),
      },
    };

    // Include service info only when a readiness check is configured
    if (readinessCheck) {
      response[serviceLabel] = {
        ready: status === ReadinessStatus.READY,
        ...(status !== ReadinessStatus.READY && { reason }),
      };
    }

    res.status(status).json(response);
  });

  return router;
}
