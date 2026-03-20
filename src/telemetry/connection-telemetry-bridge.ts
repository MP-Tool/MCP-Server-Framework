/**
 * Connection Telemetry Bridge
 *
 * Factory that creates a real ConnectionTelemetry implementation using
 * the server's OpenTelemetry tracing and metrics infrastructure.
 *
 * This bridges the api/connection module (which defines the interface)
 * with the server/telemetry module (which provides the implementation),
 * maintaining proper Dependency Inversion: api/ depends on abstractions,
 * server/ provides the concrete implementation.
 *
 * @module server/telemetry/connection-telemetry-bridge
 */

import type { ConnectionTelemetry, TelemetrySpan } from "../connection/index.js";
import { withSpan, addSpanAttributes, addSpanEvent, getServerMetrics } from "./index.js";

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a ConnectionTelemetry implementation backed by real OpenTelemetry.
 *
 * Use this when creating a ConnectionStateManager that should emit
 * distributed tracing spans and metrics.
 *
 * @example
 * ```typescript
 * import { createConnectionTelemetry } from 'mcp-server-framework/telemetry';
 * import { ConnectionStateManager } from 'mcp-server-framework/connection';
 *
 * const manager = new ConnectionStateManager(createConnectionTelemetry());
 * ```
 */
export function createConnectionTelemetry(): ConnectionTelemetry {
  return {
    async withSpan<T>(name: string, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
      return withSpan(name, (otelSpan) => {
        // Adapt OpenTelemetry Span → TelemetrySpan interface
        const bridgeSpan: TelemetrySpan = {
          setAttribute: (key, value) => otelSpan.setAttribute(key, value),
        };
        return fn(bridgeSpan);
      });
    },

    addSpanAttributes(attrs: Record<string, string | number | boolean | undefined>): void {
      addSpanAttributes(attrs);
    },

    addSpanEvent(name: string, attrs?: Record<string, string | number | boolean | undefined>): void {
      addSpanEvent(name, attrs);
    },

    recordConnectionStateChange(previousState: string, newState: string): void {
      getServerMetrics().recordConnectionStateChange(previousState, newState);
    },
  };
}
