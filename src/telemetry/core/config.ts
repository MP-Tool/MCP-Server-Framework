/**
 * Telemetry Configuration
 *
 * Provides type-safe access to OpenTelemetry settings from the central config.
 * Delegates to the application's centralized environment configuration.
 *
 * Both framework-managed and standard OTEL settings are routed through
 * the config system. This ensures a single source of truth and allows
 * all settings to be configured via environment variables OR config file.
 *
 * @module server/telemetry/core/config
 */

import type { TelemetryConfig } from "./types.js";
import { getFrameworkConfig } from "../../config/index.js";
import { TELEMETRY_DEFAULTS } from "./constants.js";

/**
 * Get telemetry configuration from centralized application config.
 *
 * Framework-managed:
 * - `OTEL_ENABLED` — Master toggle (default: false)
 * - `OTEL_SERVICE_NAME` — Service name (default: MCP server name from `createServer()`)
 * - `OTEL_METRICS_EXPORTER` — Metric exporters (default: 'otlp,prometheus')
 *
 * Standard OTEL (pass-through):
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP endpoint URL
 * - `OTEL_TRACES_EXPORTER` — Trace exporter selection
 * - `OTEL_LOGS_EXPORTER` — Log exporter selection (default: 'none')
 * - `OTEL_LOG_LEVEL` — SDK diagnostic log level
 * - `OTEL_METRIC_EXPORT_INTERVAL` — Periodic metric export interval
 *
 * @returns Telemetry configuration object
 */
export function getTelemetryConfig(): TelemetryConfig {
  const config = getFrameworkConfig();
  return {
    enabled: config.OTEL_ENABLED,
    serviceName: config.OTEL_SERVICE_NAME ?? TELEMETRY_DEFAULTS.SERVICE_NAME,
    serviceVersion: config.VERSION,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT ?? TELEMETRY_DEFAULTS.OTLP_ENDPOINT,
    tracesExporter: config.OTEL_TRACES_EXPORTER,
    logsExporter: config.OTEL_LOGS_EXPORTER,
    logLevel: config.OTEL_LOG_LEVEL,
    metricExportInterval: config.OTEL_METRIC_EXPORT_INTERVAL,
    metricsExporters: config.OTEL_METRICS_EXPORTER,
  };
}

/**
 * Check if OpenTelemetry is enabled.
 *
 * @returns true if OTEL_ENABLED=true
 */
export function isTelemetryEnabled(): boolean {
  return getFrameworkConfig().OTEL_ENABLED;
}
