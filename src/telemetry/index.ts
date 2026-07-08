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

export { initializeTelemetry, shutdownTelemetry } from "./sdk.js";

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

export type { ServerMetrics, ServerStats } from "./core/index.js";

// SpanKind alias for consumer convenience (FrameworkSpanKind is the canonical name).
export { FrameworkSpanKind as SpanKind } from "./tracing.js";
