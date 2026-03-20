/**
 * Connection Module
 *
 * Manages backend service connection state and lifecycle for the MCP framework.
 * This module is generic and client-agnostic — it works with any ServiceClient.
 *
 * This module handles the connection to backend services, NOT the MCP transport layer.
 * For transport lifecycle, see the transport-specific modules (sse/lifecycle, streamable-http/lifecycle).
 *
 * @module connection
 */

// ============================================================================
// Service Client Types
// ============================================================================

export type { HealthStatus, HealthCheckResult, ServiceClient, ServiceClientFactory } from "./types.js";
export { isServiceClient } from "./types.js";

// ============================================================================
// Core Types and Constants (centralized)
// ============================================================================

// Re-export all types from core
export type {
  // Connection State Types
  ConnectionState,
  ConnectionStateListener,
  ConnectionStateEvent,
  ConnectionStateStats,
  // Connection Error Types
  ConnectionErrorCode,
  // Telemetry Abstraction (for DI)
  ConnectionTelemetry,
  TelemetrySpan,
} from "./core/index.js";

// Note: ProgressData and ProgressReporter are exported from mcp/types/context.ts

// Re-export error codes from core
export { ConnectionErrorCodes, getMcpCodeForConnectionError, getHttpStatusForConnectionError } from "./core/index.js";

// Re-export constants from core
export {
  CONNECTION_STATES,
  CONNECTION_STATE_CONFIG,
  CONNECTION_LOG_COMPONENTS,
  CONNECTION_MCP_SPEC,
  RECONNECT_DEFAULTS,
  ConnectionStateLogMessages,
  ClientInitializerLogMessages,
  NO_OP_TELEMETRY,
} from "./core/index.js";

// ============================================================================
// Connection State Management (generic)
// ============================================================================

export { ConnectionStateManager } from "./connection-state.js";
export type { ReconnectOptions, ConnectionStateOptions } from "./connection-state.js";
