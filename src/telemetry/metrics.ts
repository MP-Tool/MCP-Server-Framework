/**
 * OpenTelemetry Metrics for Server State
 *
 * Provides metrics collection for the MCP Server including:
 * - Server uptime and startup time
 * - Active sessions and connections
 * - Request counts and latencies
 * - Memory and resource usage
 * - Connection state transitions
 *
 * @module server/telemetry/metrics
 */

// @lazy-otel — @opentelemetry/api is loaded dynamically on first use.
// The metrics API is lightweight (~200KB) but still avoided at module parse
// time so that zero OTEL code loads when telemetry is disabled. See DD-020.
import type { Counter, Histogram, UpDownCounter, Attributes } from "@opentelemetry/api";
import {
  getTelemetryConfig,
  METRIC_ATTRIBUTES,
  METRIC_NAMES,
  METRIC_DESCRIPTIONS,
  METRIC_UNITS,
  TRANSPORT_TYPES,
  TELEMETRY_LOG_COMPONENTS,
  type ServerMetrics,
  type ServerStats,
} from "./core/index.js";
import { logger as baseLogger } from "../logger/index.js";

const logger = baseLogger.child({
  component: TELEMETRY_LOG_COMPONENTS.METRICS,
});

/**
 * Lazily loads and caches the `metrics` namespace from `@opentelemetry/api`.
 * Returns null if the import fails (shouldn't happen in production).
 */
let metricsApi: typeof import("@opentelemetry/api").metrics | null = null;

async function getMetricsApi(): Promise<typeof import("@opentelemetry/api").metrics> {
  if (metricsApi) return metricsApi;
  const api = await import("@opentelemetry/api");
  metricsApi = api.metrics;
  return metricsApi;
}

/** @internal Log messages for metrics recording */
const LogMessages = {
  METRIC_REQUEST_FAILED: "Failed to record request metric: %s",
  METRIC_SESSION_FAILED: "Failed to record session metric: %s",
  METRIC_CONNECTION_STATE_FAILED: "Failed to record connection state metric: %s",
  METRIC_ERROR_FAILED: "Failed to record error metric: %s",
} as const;

/**
 * Internal structure for metric instruments.
 * @internal
 */
interface MetricInstruments {
  requestCounter?: Counter;
  requestDuration?: Histogram;
  sessionGauge?: UpDownCounter;
  connectionStateCounter?: Counter;
  errorCounter?: Counter;
}

/**
 * Server Metrics Manager
 *
 * Collects and exports metrics about server state and performance.
 * Uses OpenTelemetry metrics API when available, falls back to in-memory tracking.
 */
class ServerMetricsManager implements ServerMetrics {
  private readonly startTime: Date;
  private totalRequests = 0;
  private failedRequests = 0;
  private activeHttpSessions = 0;
  private activeSseSessions = 0;
  private connectionStateChanges = 0;

  // OpenTelemetry instruments
  private instruments: MetricInstruments = {};

  /** Resolves when OTEL instruments are initialized (or immediately if OTEL is disabled) */
  private readonly ready: Promise<void>;
  private otelInitialized = false;
  private otelDropWarningLogged = false;

  constructor() {
    this.startTime = new Date();
    // OTEL instruments are initialized asynchronously because the
    // @opentelemetry/api import is lazy-loaded (see DD-020). The async
    // init is fire-and-forget — in-memory counters always work regardless.
    // In production the lazy singleton (`getServerMetrics()`) is created
    // after `initializeTelemetry()`, so the await resolves near-instantly
    // (module already cached).
    this.ready = this.initializeMetrics()
      .then(() => {
        this.otelInitialized = true;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn("OTEL metrics initialization failed: %s (in-memory metrics still active)", reason);
      });
  }

  /**
   * Wait for OTEL instrument initialization to complete.
   *
   * Not required for normal operation — in-memory counters work immediately.
   * Useful when the caller needs to ensure OTEL metrics are captured from
   * the very first request (e.g. in integration tests).
   */
  async waitForReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Log a one-time debug warning when OTEL metrics are dropped
   * because instruments aren't initialized yet.
   */
  private warnOtelNotReady(): void {
    if (!this.otelDropWarningLogged && getTelemetryConfig().enabled) {
      this.otelDropWarningLogged = true;
      logger.debug(
        "OTEL metrics instruments not yet initialized — OTEL metric dropped (in-memory counter still recorded)",
      );
    }
  }

  /**
   * Initialize OpenTelemetry metrics instruments.
   * Async because @opentelemetry/api is lazy-loaded.
   */
  private async initializeMetrics(): Promise<void> {
    const config = getTelemetryConfig();

    if (!config.enabled) {
      return; // Skip OTEL setup if disabled
    }

    const metricsNamespace = await getMetricsApi();
    const meter = metricsNamespace.getMeter(config.serviceName, config.serviceVersion);

    // Request counter
    this.instruments.requestCounter = meter.createCounter(METRIC_NAMES.REQUESTS_TOTAL, {
      description: METRIC_DESCRIPTIONS[METRIC_NAMES.REQUESTS_TOTAL],
      unit: METRIC_UNITS.COUNT,
    });

    // Request duration histogram
    this.instruments.requestDuration = meter.createHistogram(METRIC_NAMES.REQUEST_DURATION, {
      description: METRIC_DESCRIPTIONS[METRIC_NAMES.REQUEST_DURATION],
      unit: METRIC_UNITS.MILLISECONDS,
    });

    // Session gauge (up/down counter for active sessions)
    this.instruments.sessionGauge = meter.createUpDownCounter(METRIC_NAMES.SESSIONS_ACTIVE, {
      description: METRIC_DESCRIPTIONS[METRIC_NAMES.SESSIONS_ACTIVE],
      unit: METRIC_UNITS.COUNT,
    });

    // Connection state change counter
    this.instruments.connectionStateCounter = meter.createCounter(METRIC_NAMES.CONNECTION_STATE_CHANGES, {
      description: METRIC_DESCRIPTIONS[METRIC_NAMES.CONNECTION_STATE_CHANGES],
      unit: METRIC_UNITS.COUNT,
    });

    // Error counter
    this.instruments.errorCounter = meter.createCounter(METRIC_NAMES.ERRORS_TOTAL, {
      description: METRIC_DESCRIPTIONS[METRIC_NAMES.ERRORS_TOTAL],
      unit: METRIC_UNITS.COUNT,
    });

    // Observable gauges for system metrics
    meter
      .createObservableGauge(METRIC_NAMES.UPTIME, {
        description: METRIC_DESCRIPTIONS[METRIC_NAMES.UPTIME],
        unit: METRIC_UNITS.SECONDS,
      })
      .addCallback((result) => {
        const uptimeSeconds = (Date.now() - this.startTime.getTime()) / 1000;
        result.observe(uptimeSeconds);
      });

    meter
      .createObservableGauge(METRIC_NAMES.MEMORY_HEAP_USED, {
        description: METRIC_DESCRIPTIONS[METRIC_NAMES.MEMORY_HEAP_USED],
        unit: METRIC_UNITS.BYTES,
      })
      .addCallback((result) => {
        const memUsage = process.memoryUsage();
        result.observe(memUsage.heapUsed);
      });

    meter
      .createObservableGauge(METRIC_NAMES.MEMORY_RSS, {
        description: METRIC_DESCRIPTIONS[METRIC_NAMES.MEMORY_RSS],
        unit: METRIC_UNITS.BYTES,
      })
      .addCallback((result) => {
        const memUsage = process.memoryUsage();
        result.observe(memUsage.rss);
      });
  }

  /**
   * Record a request (tool invocation).
   */
  recordRequest(toolName: string, durationMs: number, success: boolean): void {
    this.totalRequests++;
    if (!success) {
      this.failedRequests++;
    }

    if (!this.otelInitialized) {
      this.warnOtelNotReady();
      return;
    }

    try {
      const attributes: Attributes = {
        [METRIC_ATTRIBUTES.TOOL_NAME]: toolName,
        [METRIC_ATTRIBUTES.SUCCESS]: String(success),
      };

      this.instruments.requestCounter?.add(1, attributes);
      this.instruments.requestDuration?.record(durationMs, attributes);
    } catch (error) {
      /* v8 ignore next 3 - OTEL error handling */
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(LogMessages.METRIC_REQUEST_FAILED, message);
    }
  }

  /**
   * Record an active session change.
   * @param transport - Transport type ('http' or 'sse')
   * @param delta - Change in session count (+1 for new, -1 for closed)
   */
  recordSessionChange(transport: string, delta: number): void {
    let actualDelta = delta;

    if (transport === TRANSPORT_TYPES.HTTP) {
      const previous = this.activeHttpSessions;
      this.activeHttpSessions = Math.max(0, previous + delta);
      actualDelta = this.activeHttpSessions - previous;
    } else if (transport === TRANSPORT_TYPES.SSE) {
      const previous = this.activeSseSessions;
      this.activeSseSessions = Math.max(0, previous + delta);
      actualDelta = this.activeSseSessions - previous;
    }

    try {
      this.instruments.sessionGauge?.add(actualDelta, {
        [METRIC_ATTRIBUTES.TRANSPORT]: transport,
      });
    } catch (error) {
      /* v8 ignore next 3 - OTEL error handling */
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(LogMessages.METRIC_SESSION_FAILED, message);
    }
  }

  /**
   * Record a connection state change.
   */
  recordConnectionStateChange(previousState: string, newState: string): void {
    this.connectionStateChanges++;

    try {
      this.instruments.connectionStateCounter?.add(1, {
        [METRIC_ATTRIBUTES.PREVIOUS_STATE]: previousState,
        [METRIC_ATTRIBUTES.CURRENT_STATE]: newState,
      });
    } catch (error) {
      /* v8 ignore next 3 - OTEL error handling */
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(LogMessages.METRIC_CONNECTION_STATE_FAILED, message);
    }
  }

  /**
   * Record an error.
   */
  recordError(errorType: string, component: string): void {
    try {
      this.instruments.errorCounter?.add(1, {
        [METRIC_ATTRIBUTES.ERROR_TYPE]: errorType,
        [METRIC_ATTRIBUTES.COMPONENT]: component,
      });
    } catch (error) {
      /* v8 ignore next 3 - OTEL error handling */
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(LogMessages.METRIC_ERROR_FAILED, message);
    }
  }

  /**
   * Get current server statistics.
   */
  getStats(): ServerStats {
    const memUsage = process.memoryUsage();

    return {
      uptimeMs: Date.now() - this.startTime.getTime(),
      startTime: this.startTime,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      activeHttpSessions: this.activeHttpSessions,
      activeSseSessions: this.activeSseSessions,
      connectionStateChanges: this.connectionStateChanges,
      memoryUsageBytes: memUsage.rss,
      heapUsedBytes: memUsage.heapUsed,
    };
  }

  /**
   * Reset all statistics.
   * Useful for testing.
   */
  reset(): void {
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.activeHttpSessions = 0;
    this.activeSseSessions = 0;
    this.connectionStateChanges = 0;
  }
}

// ============================================================================
// Factory & Singleton
// ============================================================================

/** Singleton instance - lazily initialized */
let instance: ServerMetricsManager | null = null;

/**
 * Create a new ServerMetricsManager instance.
 *
 * Use this factory function for testing or when you need
 * an independent metrics instance.
 *
 * @returns A new ServerMetricsManager instance
 *
 * @example
 * ```typescript
 * // For testing - create isolated instance
 * const metrics = createServerMetrics();
 * metrics.recordRequest('test-tool', 100, true);
 * ```
 */
export function createServerMetrics(): ServerMetricsManager {
  return new ServerMetricsManager();
}

/**
 * Get the singleton ServerMetricsManager instance.
 *
 * This is the recommended way to access metrics in production code.
 * The instance is lazily initialized on first access.
 *
 * @returns The singleton ServerMetricsManager instance
 *
 * @example
 * ```typescript
 * import { getServerMetrics } from './telemetry/metrics.js';
 *
 * const metrics = getServerMetrics();
 * metrics.recordRequest('tool_name', 150, true);
 * ```
 */
export function getServerMetrics(): ServerMetricsManager {
  if (!instance) {
    instance = new ServerMetricsManager();
  }
  return instance;
}

/**
 * Reset the singleton instance.
 *
 * **Warning**: Only use this for testing purposes.
 * This will reset all tracked metrics. A fresh instance with new OTEL
 * instruments will be created on the next `getServerMetrics()` call.
 *
 * Note: OTEL metric instruments are cumulative by design — resetting
 * in-memory counters does not affect already-exported metric data points.
 * The new instance re-creates instruments from the global MeterProvider.
 *
 * @internal
 */
export function resetServerMetrics(): void {
  instance = null;
}

// Export the class for testing
export { ServerMetricsManager };
