/**
 * Telemetry Core Module
 *
 * Barrel export for centralized types, constants, and configuration.
 *
 * @module server/telemetry/core
 */

// ============================================================================
// Types
// ============================================================================

export type {
  TelemetryConfig,
  SpanOptions,
  SpanCallback,
  AsyncSpanCallback,
  ServerMetrics,
  ServerStats,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

export {
  TELEMETRY_DEFAULTS,
  MCP_ATTRIBUTES,
  METRIC_ATTRIBUTES,
  METRIC_NAMES,
  METRIC_DESCRIPTIONS,
  METRIC_UNITS,
  TELEMETRY_LOG_COMPONENTS,
  SdkLogMessages,
  TRANSPORT_TYPES,
} from "./constants.js";

// ============================================================================
// Configuration
// ============================================================================

export { getTelemetryConfig, isTelemetryEnabled } from "./config.js";

// ============================================================================
// DiagLogger
// ============================================================================

export { frameworkDiagLogger } from "./diag-logger.js";
