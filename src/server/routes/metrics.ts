/**
 * Prometheus Metrics Route
 *
 * Exposes OpenTelemetry metrics in Prometheus text format at `/metrics`.
 *
 * The route delegates to the embedded PrometheusExporter registered as a
 * MetricReader in the SDK. When telemetry is disabled or 'prometheus' is
 * not in OTEL_METRICS_EXPORTER, the endpoint returns 503.
 *
 * All metrics are collected centrally by OpenTelemetry — no custom metric
 * implementations. The Prometheus exporter serializes the same data that
 * is also exported to OTLP backends.
 *
 * Exposed metrics include:
 * - `mcp_server_*` — MCP server metrics (requests, sessions, errors, uptime, memory)
 * - `http_server_*` — HTTP server metrics from auto-instrumentation
 * - `target_info` — Service resource attributes
 *
 * @module server/routes/metrics
 */

import { Router } from "express";
import { getPrometheusExporter } from "../../telemetry/index.js";
import { logger as baseLogger } from "../../logger/index.js";

const COMPONENT = "MetricsRoute";
const logger = baseLogger.child({ component: COMPONENT });

/** @internal Log messages for the metrics route */
const LogMessages = {
  TELEMETRY_DISABLED: "Metrics endpoint requested but Prometheus exporter is not available",
} as const;

// ============================================================================
// Content Types
// ============================================================================

/**
 * Prometheus text exposition format content type.
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/
 */
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

// ============================================================================
// Metrics Router Factory
// ============================================================================

/**
 * Creates an Express router that serves Prometheus-formatted metrics.
 *
 * Delegates to the `PrometheusExporter` request handler registered as a
 * MetricReader in the SDK ({@link initializeTelemetry}). Returns 503 when
 * telemetry is disabled or 'prometheus' is not in OTEL_METRICS_EXPORTER.
 *
 * @returns Express Router with GET /metrics handler
 *
 * @example
 * ```typescript
 * import { createMetricsRouter } from './routes/metrics.js';
 *
 * const app = express();
 * app.use(createMetricsRouter());
 * ```
 */
export function createMetricsRouter(): Router {
  const router = Router();

  router.get("/metrics", (req, res) => {
    const exporter = getPrometheusExporter();

    if (!exporter) {
      logger.debug(LogMessages.TELEMETRY_DISABLED);
      res.status(503).json({
        error: "Prometheus metrics not available",
        hint: 'Set OTEL_ENABLED=true and include "prometheus" in OTEL_METRICS_EXPORTER',
      });
      return;
    }

    // @express-api — PrometheusExporter.getMetricsRequestHandler expects
    // Node.js IncomingMessage/ServerResponse, which Express req/res extend.
    // @type-narrowing — getPrometheusExporter() returns `unknown` because the
    // PrometheusExporter class is lazy-loaded (DD-020). The null check above
    // guarantees the exporter exists, and its API is known.
    res.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
    const handler = exporter as {
      getMetricsRequestHandler: (req: unknown, res: unknown) => void;
    };
    handler.getMetricsRequestHandler(req, res);
  });

  return router;
}
