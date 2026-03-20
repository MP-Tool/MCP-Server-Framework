/**
 * Connection Core Module
 *
 * Barrel export for centralized types and constants.
 *
 * @module connection/core
 */

// Types
export type {
  // Connection State Types
  ConnectionState,
  ConnectionStateListener,
  ConnectionStateEvent,
  ConnectionStateStats,
  // Telemetry Abstraction
  ConnectionTelemetry,
  TelemetrySpan,
} from "./types.js";

// Note: ProgressData and ProgressReporter are exported from mcp/types/context.ts (canonical source)

export { CONNECTION_STATES, NO_OP_TELEMETRY } from "./types.js";

// Connection Error Codes & Mappings
export { ConnectionErrorCodes, getMcpCodeForConnectionError, getHttpStatusForConnectionError } from "./base.js";
export type { ConnectionErrorCode } from "./base.js";

// Constants
export {
  CONNECTION_STATE_CONFIG,
  CONNECTION_LOG_COMPONENTS,
  CONNECTION_MCP_SPEC,
  RECONNECT_DEFAULTS,
  VALID_STATE_TRANSITIONS,
  ConnectionStateLogMessages,
  ClientInitializerLogMessages,
} from "./constants.js";
