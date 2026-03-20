/**
 * Telemetry Module
 *
 * OpenTelemetry integration for distributed tracing and metrics.
 *
 * ## Setup
 *
 * Enable telemetry with environment variables:
 * ```bash
 * OTEL_ENABLED=true
 * OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 * ```
 *
 * All OTEL settings are routed through the config system (env vars + config file):
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` — OTLP endpoint URL
 * - `OTEL_TRACES_EXPORTER` — Trace exporter: otlp (default), console, none
 * - `OTEL_LOG_LEVEL` — SDK diagnostic log level
 * - `OTEL_METRIC_EXPORT_INTERVAL` — Metric export interval (ms)
 *
 * Framework-managed env vars:
 * - `OTEL_METRICS_EXPORTER` — otlp, prometheus, console, none (default: otlp,prometheus)
 *
 * ## Usage
 *
 * ```typescript
 * import { initializeTelemetry, withSpan, getTraceContext, serverMetrics } from './telemetry/index.js';
 *
 * // Initialize at startup
 * initializeTelemetry();
 *
 * // Create spans
 * await withSpan('myOperation', async (span) => {
 *   span.setAttribute('key', 'value');
 *   return await doSomething();
 * });
 *
 * // Get trace context for propagation
 * const ctx = getTraceContext();
 *
 * // Record metrics
 * serverMetrics.recordRequest('tool_name', 150, true);
 * ```
 *
 * @module server/telemetry
 */

// ============================================================================
// SDK Lifecycle
// ============================================================================

export { initializeTelemetry, shutdownTelemetry, isSdkInitialized, getPrometheusExporter } from "./sdk.js";

// ============================================================================
// Configuration
// ============================================================================

export { getTelemetryConfig, isTelemetryEnabled } from "./core/index.js";
export type { TelemetryConfig } from "./core/index.js";

// ============================================================================
// Tracing
// ============================================================================

export {
  getTracer,
  withSpan,
  withSpanSync,
  getActiveSpan,
  addSpanAttributes,
  addSpanEvent,
  getTraceContext,
  FrameworkSpanKind,
  FrameworkSpanStatusCode,
} from "./tracing.js";

export { MCP_ATTRIBUTES } from "./core/index.js";
export type { SpanOptions, TraceContext, SpanCallback, AsyncSpanCallback } from "./core/index.js";

// ============================================================================
// Metrics
// ============================================================================

export { ServerMetricsManager, createServerMetrics, getServerMetrics, resetServerMetrics } from "./metrics.js";
export { METRIC_ATTRIBUTES } from "./core/index.js";
export type { ServerMetrics, ServerStats } from "./core/index.js";

// ============================================================================
// Constants (for advanced usage)
// ============================================================================

export {
  TELEMETRY_DEFAULTS,
  TELEMETRY_ENV_VARS,
  METRIC_NAMES,
  METRIC_DESCRIPTIONS,
  METRIC_UNITS,
  TRANSPORT_TYPES,
  TELEMETRY_LOG_COMPONENTS,
  SdkLogMessages,
} from "./core/index.js";

// ============================================================================
// OpenTelemetry-compatible Re-exports (framework-level, no static OTEL import)
// ============================================================================

// SpanKind & SpanStatusCode are re-exported as FrameworkSpanKind / FrameworkSpanStatusCode
// from tracing.js above. For backward-compat, provide aliases with the original names.
// Type-only re-exports remain zero-cost.
export { FrameworkSpanKind as SpanKind, FrameworkSpanStatusCode as SpanStatusCode } from "./tracing.js";
export type { Span, Attributes, Context, Tracer } from "@opentelemetry/api";

// ============================================================================
// Connection Telemetry Bridge
// ============================================================================

export { createConnectionTelemetry } from "./connection-telemetry-bridge.js";
