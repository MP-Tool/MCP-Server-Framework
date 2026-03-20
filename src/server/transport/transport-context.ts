/**
 * Transport Context Types
 *
 * Transport-layer concerns for MCP sessions including connection details,
 * transport type discrimination, and heartbeat tracking.
 *
 * @module server/transport/transport-context
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ============================================================================
// Transport Types
// ============================================================================

/**
 * Supported transport types in the framework.
 */
export type TransportType = "http" | "https" | "sse" | "stdio";

// ============================================================================
// Heartbeat Types
// ============================================================================

/**
 * Transport that optionally supports heartbeat (keep-alive).
 *
 * Some transports (like StreamableHTTPServerTransport) support sendHeartbeat
 * but it's not in the public SDK types.
 */
export interface HeartbeatCapableTransport extends Transport {
  /**
   * Sends a heartbeat to check if the connection is still alive.
   * @returns true if heartbeat was sent successfully
   */
  sendHeartbeat: () => boolean;
}

/**
 * Heartbeat tracking state.
 *
 * Immutable — create new objects via spread to update.
 */
export interface HeartbeatState {
  /** Number of consecutive missed heartbeats */
  readonly missedCount: number;

  /** Last successful heartbeat timestamp */
  readonly lastSuccessAt?: Date;

  /** Whether this transport supports heartbeats */
  readonly supportsHeartbeat: boolean;
}

// ============================================================================
// Transport Context
// ============================================================================

/**
 * Transport-specific context containing connection details.
 *
 * Encapsulates all transport-layer concerns:
 * - The actual MCP transport instance
 * - Transport type for runtime discrimination
 * - Heartbeat tracking for connection health
 */
export interface TransportContext {
  /** Discriminator for transport type */
  readonly type: TransportType;

  /** MCP SDK transport instance */
  readonly instance: Transport;

  /** Heartbeat tracking (only for HTTP-based transports) */
  heartbeat: HeartbeatState;
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Type guard for heartbeat-capable transports.
 *
 * Checks if the transport has a `sendHeartbeat` method.
 * Used to safely narrow `Transport` without unchecked casts.
 */
export function isHeartbeatCapable(transport: Transport): transport is HeartbeatCapableTransport {
  // @type-guard — Standard TS pattern: cast to target type for property access within type predicate
  return typeof (transport as HeartbeatCapableTransport).sendHeartbeat === "function";
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Factory to create transport context from transport instance.
 */
export function createTransportContext(type: TransportType, transport: Transport): TransportContext {
  return {
    type,
    instance: transport,
    heartbeat: {
      missedCount: 0,
      supportsHeartbeat: isHeartbeatCapable(transport),
    },
  };
}
