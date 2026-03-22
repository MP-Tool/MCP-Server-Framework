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
import type { ConnectionStateManager } from "../../connection/index.js";
import type { ServiceClient } from "../../connection/types.js";
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
export interface HealthRouterOptions<TService extends ServiceClient = ServiceClient> {
  /** Session manager for tracking active sessions */
  sessionManager: SessionManager;

  /**
   * Optional connection manager for API health checks.
   * If not provided, API connectivity checks are skipped.
   */
  connectionManager?: ConnectionStateManager<TService> | undefined;

  /**
   * Function to check if API is configured.
   * Reads from runtime environment to support Docker env_file.
   * If not provided, defaults to checking for API_URL env var.
   */
  isApiConfigured?: (() => boolean) | undefined;

  /**
   * Label for the API in health responses (e.g., 'my-api', 'docker', 'kubernetes')
   * Defaults to 'api'
   */
  apiLabel?: string | undefined;

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
 * Creates health check router with configurable API connection monitoring.
 *
 * @param options - Configuration options for the health router
 * @returns Express router with /health and /ready endpoints
 *
 * @example
 * ```typescript
 * // Basic usage (no API monitoring)
 * const router = createHealthRouter({ sessionManager });
 *
 * // With API connection monitoring
 * const router = createHealthRouter({
 *   sessionManager,
 *   connectionManager: myConnectionManager,
 *   isApiConfigured: () => !!process.env.API_URL,
 *   apiLabel: 'api',
 * });
 * ```
 */
export function createHealthRouter<TService extends ServiceClient = ServiceClient>(
  options: HealthRouterOptions<TService>,
): Router {
  const {
    sessionManager,
    connectionManager,
    isApiConfigured = () => !!process.env.API_URL?.trim(),
    apiLabel = "api",
    sseInfo,
  } = options;

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
  router.get(ROUTES.READY, (_req, res) => {
    const config = getFrameworkConfig();

    // Get API connection state (if connection manager is provided)
    const connectionState = connectionManager?.getState() ?? "unknown";
    const isApiConnected = connectionState === "connected";

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

    // Determine readiness
    const hasApiConfig = isApiConfigured();
    const apiReady = !hasApiConfig || isApiConnected;

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
    } else if (!apiReady) {
      status = ReadinessStatus.SERVICE_UNAVAILABLE;
      reason = `${apiLabel} not connected (state: ${connectionState})`;
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

    const response = {
      ready: isReady,
      status: reason,
      version: config.VERSION,
      uptime: process.uptime(),
      [apiLabel]: {
        configured: hasApiConfig,
        state: connectionState,
        connected: isApiConnected,
      },
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

    res.status(status).json(response);
  });

  return router;
}
