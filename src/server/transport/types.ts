/**
 * Transport Types
 *
 * Cross-module type definitions for the transport layer.
 * Only types used by multiple transport sub-modules are defined here.
 * Internal types are co-located with their consuming modules.
 *
 * @module server/transport/types
 */

import type { McpSession } from "../session/index.js";

export type {
  TransportType,
  HeartbeatCapableTransport,
  HeartbeatState,
  TransportContext,
} from "./transport-context.js";

export { createTransportContext, isHeartbeatCapable } from "./transport-context.js";

// ============================================================================
// Transport Lifecycle
// ============================================================================

/**
 * Transport state values for lifecycle tracking.
 */
export type TransportState = "created" | "starting" | "running" | "stopping" | "stopped" | "error";

// ============================================================================
// Session Factory
// ============================================================================

/**
 * Factory function type for creating McpSession instances.
 *
 * Used by the transport layer where each connected client
 * gets an McpSession with protocol handlers and SDK-native
 * cancellation/progress support.
 *
 * @returns A new McpSession instance for the client
 */
export type SessionFactory = () => McpSession;

// ============================================================================
// Transport Handle
// ============================================================================

/**
 * Lightweight handle returned by transport start functions.
 *
 * Replaces the former TransportManager class hierarchy with a simple
 * functional interface: start returns a handle, call shutdown to stop.
 */
export interface TransportHandle {
  /** Graceful shutdown of the transport */
  shutdown(): Promise<void>;
  /** Get runtime transport information */
  info(): TransportInfo;
}

// ============================================================================
// Transport Info
// ============================================================================

/**
 * Runtime information about the active transport.
 */
export interface TransportInfo {
  /** Current transport state */
  readonly state: TransportState;
  /** When the transport was started */
  readonly startedAt?: Date | undefined;
  /** Transport mode identifier (e.g., 'stdio', 'http', 'https') */
  readonly mode?: string | undefined;
  /** Host address (HTTP/HTTPS only) */
  readonly host?: string | undefined;
  /** Port number (HTTP/HTTPS only) */
  readonly port?: number | undefined;
  /** Full URL (HTTP/HTTPS only) */
  readonly url?: string | undefined;
}
