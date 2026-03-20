/**
 * Telemetry Module Types
 *
 * Centralized type definitions for the OpenTelemetry integration module.
 * Includes configuration, tracing, and metrics types.
 *
 * @module server/telemetry/core/types
 */

import type { Span, SpanKind, Attributes, Context } from "@opentelemetry/api";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * OpenTelemetry configuration options.
 *
 * Contains both framework-managed settings and standard OTEL settings
 * that are passed through the config system for unified configuration.
 */
export interface TelemetryConfig {
  /** Whether OpenTelemetry is enabled */
  readonly enabled: boolean;
  /** Service name for traces and metrics */
  readonly serviceName: string;
  /** Service version */
  readonly serviceVersion: string;

  // -- Standard OTEL settings (pass-through from config system) ---------------

  /** OTLP exporter endpoint URL. Defaults to OTEL standard: http://localhost:4318 */
  readonly endpoint: string;
  /** Trace exporter: 'otlp', 'console', 'none' */
  readonly tracesExporter?: string | undefined;
  /** Log exporter: 'otlp', 'console', 'none'. Default: 'none' (framework uses own logger) */
  readonly logsExporter: string;
  /** SDK diagnostic log level: 'NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'VERBOSE', 'ALL' */
  readonly logLevel?: string | undefined;
  /** Periodic metric export interval in milliseconds */
  readonly metricExportInterval?: number | undefined;

  /**
   * Active metric exporters (parsed from OTEL_METRICS_EXPORTER).
   * Supported values: 'otlp', 'prometheus', 'console', 'none'.
   */
  readonly metricsExporters: readonly string[];
}

// ============================================================================
// Tracing Types
// ============================================================================

/**
 * Options for creating a span.
 */
export interface SpanOptions {
  /** Span kind (default: INTERNAL) */
  kind?: SpanKind;
  /** Initial attributes */
  attributes?: Attributes;
  /** Parent context (uses active context if not provided) */
  parentContext?: Context;
}

/**
 * Trace context for propagation to external services.
 */
export interface TraceContext {
  /** Trace ID */
  readonly traceId: string;
  /** Span ID */
  readonly spanId: string;
}

/**
 * Function signature for span execution callback.
 */
export type SpanCallback<T> = (span: Span) => T;

/**
 * Function signature for async span execution callback.
 */
export type AsyncSpanCallback<T> = (span: Span) => Promise<T>;

// ============================================================================
// Metrics Types
// ============================================================================

/**
 * Server metrics interface for type-safe metric recording.
 */
export interface ServerMetrics {
  /** Record a request (tool invocation) */
  recordRequest(toolName: string, durationMs: number, success: boolean): void;
  /** Record an active session change */
  recordSessionChange(transport: string, delta: number): void;
  /** Record a connection state change */
  recordConnectionStateChange(previousState: string, newState: string): void;
  /** Record an error */
  recordError(errorType: string, component: string): void;
  /** Get current server stats */
  getStats(): ServerStats;
}

/**
 * Server statistics snapshot.
 */
export interface ServerStats {
  /** Server uptime in milliseconds */
  readonly uptimeMs: number;
  /** Server start time */
  readonly startTime: Date;
  /** Total requests processed */
  readonly totalRequests: number;
  /** Failed requests */
  readonly failedRequests: number;
  /** Active HTTP sessions */
  readonly activeHttpSessions: number;
  /** Active SSE sessions */
  readonly activeSseSessions: number;
  /** Connection state changes count */
  readonly connectionStateChanges: number;
  /** Current memory usage in bytes */
  readonly memoryUsageBytes: number;
  /** Current heap used in bytes */
  readonly heapUsedBytes: number;
}

// TransportType removed — use canonical definition from session module

// ============================================================================
// Re-export OpenTelemetry Types (for convenience)
// These are re-exported so consumers don't need to import from @opentelemetry/api
// ============================================================================

export type { Span, SpanKind, Attributes, Context } from "@opentelemetry/api";
