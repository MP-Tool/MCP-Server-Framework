/**
 * Connection Module Types
 *
 * Centralized type definitions for the connection module.
 * Includes connection state management and request tracking types.
 * Generic types work with any service client implementing ServiceClient.
 *
 * @module connection/core/types
 */

import type { ServiceClient } from "../types.js";

// ============================================================================
// Telemetry Abstraction (Dependency Inversion)
// ============================================================================

/**
 * Telemetry operations used by ConnectionStateManager.
 *
 * Abstracts tracing and metrics to avoid a direct dependency
 * from connection/ → server/telemetry/. Callers inject the
 * real implementation; the default is a no-op.
 */
export interface ConnectionTelemetry {
  /** Wrap an async operation in a tracing span. */
  withSpan<T>(name: string, fn: (span: TelemetrySpan) => Promise<T>): Promise<T>;

  /** Add attributes to the current active span. */
  addSpanAttributes(attrs: Record<string, string | number | boolean | undefined>): void;

  /** Add a named event to the current active span. */
  addSpanEvent(name: string, attrs?: Record<string, string | number | boolean | undefined>): void;

  /** Record a connection state transition in metrics. */
  recordConnectionStateChange(previousState: string, newState: string): void;
}

/**
 * Minimal span interface for the telemetry abstraction.
 * Avoids importing OpenTelemetry API types into the connection/ layer.
 */
export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
}

/**
 * No-op telemetry implementation.
 *
 * Used as default when no telemetry is injected. All methods are silent no-ops,
 * which is safe because the server/telemetry module already handles the
 * "OTEL not initialized" case the same way.
 */
export const NO_OP_TELEMETRY: ConnectionTelemetry = {
  async withSpan<T>(_name: string, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    const noopSpan: TelemetrySpan = { setAttribute: () => {} };
    return fn(noopSpan);
  },
  addSpanAttributes: () => {},
  addSpanEvent: () => {},
  recordConnectionStateChange: () => {},
};

// ============================================================================
// Connection State Types
// ============================================================================

/**
 * Possible connection states for the service client.
 *
 * State Machine:
 * ```
 * disconnected ──▶ connecting ──▶ connected
 *      ▲                │              │
 *      │                ▼              │
 *      └──────────── error ◀──────────┘
 * ```
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * All possible connection states as a readonly array.
 * Useful for validation and iteration.
 */
export const CONNECTION_STATES = ["disconnected", "connecting", "connected", "error"] as const;

/**
 * Listener function signature for connection state changes.
 *
 * @typeParam TService - The service client type (must implement ServiceClient)
 * @param state - The new connection state
 * @param client - The service client (null if not connected)
 * @param error - Error object if state is 'error'
 */
export type ConnectionStateListener<TService extends ServiceClient = ServiceClient> = (
  state: ConnectionState,
  client: TService | null,
  error?: Error,
) => void;

/**
 * Event object representing a connection state transition.
 * Used for history tracking and debugging.
 *
 * @typeParam TService - The service client type (must implement ServiceClient)
 */
export interface ConnectionStateEvent {
  /** The previous connection state */
  readonly previousState: ConnectionState;
  /** The new (current) connection state */
  readonly currentState: ConnectionState;
  /** The client type identifier at the time of transition (e.g. 'my-api') */
  readonly clientType: string | null;
  /** Error that caused the transition (if applicable) */
  readonly error?: Error | undefined;
  /** Timestamp when the transition occurred */
  readonly timestamp: Date;
}

/**
 * Statistics about the connection state manager.
 */
export interface ConnectionStateStats {
  /** Current connection state */
  readonly state: ConnectionState;
  /** Whether currently connected */
  readonly isConnected: boolean;
  /** Number of registered listeners */
  readonly listenerCount: number;
  /** Number of state transitions in history */
  readonly historyLength: number;
  /** Last error if any */
  readonly lastError: Error | null;
}
