/**
 * Connection State Manager
 *
 * Manages the connection state to a backend service and notifies
 * listeners when the state changes. This enables dynamic tool
 * availability based on connection status.
 *
 * Generic implementation works with any service client implementing ServiceClient.
 *
 * @module connection/connection-state
 */

import type { ServiceClient } from "./types.js";
import { logger as baseLogger } from "../logger/index.js";
import { ConnectionError } from "../errors/index.js";

// Import centralized types and constants from core
import type {
  ConnectionState,
  ConnectionStateListener,
  ConnectionStateEvent,
  ConnectionTelemetry,
} from "./core/types.js";
import { NO_OP_TELEMETRY } from "./core/types.js";
import {
  CONNECTION_STATE_CONFIG,
  CONNECTION_LOG_COMPONENTS,
  ConnectionStateLogMessages,
  VALID_STATE_TRANSITIONS,
  RECONNECT_DEFAULTS,
} from "./core/constants.js";

const logger = baseLogger.child({
  component: CONNECTION_LOG_COMPONENTS.CONNECTION_STATE,
});

// Re-export types for backwards compatibility
export type { ConnectionState } from "./core/types.js";

/**
 * Options for automatic reconnection with exponential backoff.
 *
 * When auto-reconnect is enabled, the ConnectionStateManager will
 * automatically attempt to re-establish the connection when the
 * state transitions to 'error'.
 *
 * This handles reconnection to the **API backend** (e.g. a REST API service),
 * NOT MCP transport reconnection (which is client-side, handled by the SDK).
 */
export interface ReconnectOptions {
  /** Maximum number of reconnect attempts before giving up. Default: 5 */
  readonly maxRetries?: number;
  /** Initial delay before the first reconnect attempt in ms. Default: 1000 */
  readonly initialDelayMs?: number;
  /** Maximum delay between attempts in ms (caps exponential growth). Default: 30000 */
  readonly maxDelayMs?: number;
  /** Multiplier for exponential backoff. Default: 1.5 */
  readonly backoffMultiplier?: number;
}

/**
 * Options for ConnectionStateManager construction.
 */
export interface ConnectionStateOptions {
  /** Optional telemetry implementation (defaults to no-op). */
  readonly telemetry?: ConnectionTelemetry;
  /** Health check timeout in milliseconds. Default: 10000 */
  readonly healthCheckTimeoutMs?: number;
}

/**
 * Manages the connection state to a backend service.
 *
 * Generic implementation that works with any client implementing ServiceClient.
 *
 * Features:
 * - Tracks connection state (disconnected, connecting, connected, error)
 * - Notifies listeners when state changes
 * - Provides current client instance
 * - Supports health check validation
 * - Uses circular buffer for efficient history management (O(1) operations)
 *
 * @typeParam TService - The service client type (must implement ServiceClient)
 *
 * @example
 * ```typescript
 * const manager = new ConnectionStateManager<MyServiceClient>();
 * manager.onStateChange((state, client) => {
 *   if (state === 'connected') {
 *     console.log('Connected!');
 *   }
 * });
 * await manager.connect(serviceClient);
 *
 * // With any ServiceClient implementation
 * const genericManager = new ConnectionStateManager<MyServiceClient>();
 * ```
 */
export class ConnectionStateManager<TService extends ServiceClient = ServiceClient> {
  private state: ConnectionState = "disconnected";
  private client: TService | null = null;
  private lastError: Error | null = null;
  private listeners: Set<ConnectionStateListener<TService>> = new Set();

  /** Injected telemetry — defaults to no-op when not provided. */
  private readonly telemetry: ConnectionTelemetry;

  /** Health check timeout in milliseconds. */
  private readonly healthCheckTimeoutMs: number;

  // Performance: Use circular buffer instead of array with shift()
  // shift() is O(n), circular buffer is O(1)
  private readonly maxHistorySize = CONNECTION_STATE_CONFIG.MAX_HISTORY_SIZE;
  private stateHistory: (ConnectionStateEvent | null)[] = new Array(this.maxHistorySize).fill(null);
  private historyIndex = 0;
  private historyCount = 0;

  // Auto-reconnect state
  private _reconnectAbort: AbortController | null = null;
  private _reconnectUnsubscribe: (() => void) | null = null;

  /**
   * Create a new ConnectionStateManager.
   *
   * @param options - Optional configuration (telemetry, healthCheckTimeoutMs).
   *   Also accepts a bare `ConnectionTelemetry` for backwards compatibility.
   */
  constructor(options?: ConnectionStateOptions | ConnectionTelemetry) {
    // Backwards compatibility: accept bare telemetry object
    if (options && "withSpan" in options) {
      this.telemetry = options;
      this.healthCheckTimeoutMs = CONNECTION_STATE_CONFIG.HEALTH_CHECK_TIMEOUT_MS;
    } else {
      this.telemetry = options?.telemetry ?? NO_OP_TELEMETRY;
      this.healthCheckTimeoutMs = options?.healthCheckTimeoutMs ?? CONNECTION_STATE_CONFIG.HEALTH_CHECK_TIMEOUT_MS;
    }
  }

  /**
   * Get the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get the current service client instance.
   * Returns null if not connected.
   */
  getClient(): TService | null {
    return this.client;
  }

  /**
   * Check if the client is currently connected.
   */
  isConnected(): boolean {
    return this.state === "connected" && this.client !== null;
  }

  /**
   * Get the last error that occurred (if any).
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Get the connection state history.
   * Returns the most recent state changes (up to maxHistorySize).
   * History is returned in chronological order (oldest first).
   */
  getHistory(): readonly ConnectionStateEvent[] {
    // Reconstruct array from circular buffer in chronological order
    const result: ConnectionStateEvent[] = [];
    for (let i = 0; i < this.historyCount; i++) {
      // Circular buffer read: start from the oldest entry and walk forward.
      // historyIndex points to the NEXT write position, so the oldest entry
      // is at (historyIndex - historyCount). Adding maxHistorySize before
      // modulo prevents negative indices.
      const index = (this.historyIndex - this.historyCount + i + this.maxHistorySize) % this.maxHistorySize;
      const event = this.stateHistory[index];
      /* v8 ignore start - defensive check for circular buffer integrity */
      if (event) {
        result.push(event);
      }
      /* v8 ignore stop */
    }
    return result;
  }

  /**
   * Register a listener for connection state changes.
   *
   * @param listener - Function to call when state changes
   * @returns Unsubscribe function
   */
  onStateChange(listener: ConnectionStateListener<TService>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Set the connection state to 'connecting'.
   * Call this before attempting to connect.
   */
  setConnecting(): void {
    this.setState("connecting");
  }

  /**
   * Set the client and mark as connected.
   * Validates the connection with a health check before completing.
   * Includes OpenTelemetry tracing for the connection process.
   *
   * @param client - The authenticated service client
   * @param skipHealthCheck - Skip health check validation (for testing)
   * @returns true if connection was successful
   */
  async connect(client: TService, skipHealthCheck = false): Promise<boolean> {
    return this.telemetry.withSpan("api.connection.connect", async (span) => {
      this.setState("connecting");
      logger.debug(ConnectionStateLogMessages.CONNECTING);
      this.telemetry.addSpanAttributes({
        "mcp.operation": "connect",
        "connection.skip_health_check": skipHealthCheck,
        "connection.client_type": client.clientType,
      });

      try {
        if (!skipHealthCheck) {
          await this.performHealthCheck(client);
        }

        this.client = client;
        this.lastError = null;
        this.setState("connected");
        this.telemetry.addSpanEvent("connection.established");

        return true;
        /* v8 ignore start - catch block for connection errors */
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.setState("error", this.lastError);
        span.setAttribute("error.message", this.lastError.message);
        logger.error(ConnectionStateLogMessages.ERROR_STATE, this.lastError.message);

        return false;
      }
      /* v8 ignore stop */
    });
  }

  /**
   * Perform health check validation against the service client.
   * Throws if the health check fails or times out.
   */
  private async performHealthCheck(client: TService): Promise<void> {
    const healthCheckFn = client.healthCheck?.bind(client);

    if (!healthCheckFn) {
      // No healthCheck method — assume healthy
      this.telemetry.addSpanEvent("health_check.skipped", {
        reason: "not_implemented",
      });
      logger.debug(ConnectionStateLogMessages.HEALTH_CHECK_SKIPPED);
      return;
    }

    this.telemetry.addSpanEvent("health_check.start");
    const timeoutMs = this.healthCheckTimeoutMs;
    logger.trace(ConnectionStateLogMessages.HEALTH_CHECK_START);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const health = await Promise.race([
        healthCheckFn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);

      if (health.status !== "healthy") {
        this.telemetry.addSpanEvent("health_check.failed", {
          "health.message": health.message || "unknown",
        });
        logger.warn(ConnectionStateLogMessages.HEALTH_CHECK_FAILED, health.message || "unknown");
        throw ConnectionError.healthCheckFailed(health.message || "unknown");
      }

      this.telemetry.addSpanEvent("health_check.success", {
        "health.status": health.status,
        "health.message": health.message || "ok",
      });

      /* v8 ignore next - optional API version logging */
      logger.debug(ConnectionStateLogMessages.HEALTH_CHECK_SUCCESS);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Disconnect from the backend service.
   * Calls {@link ServiceClient.disconnect} if the client implements it,
   * then clears the client reference and sets state to 'disconnected'.
   */
  async disconnect(): Promise<void> {
    // Stop auto-reconnect so it doesn't trigger on the disconnect state change
    this.disableAutoReconnect();

    this.telemetry.addSpanEvent("connection.disconnect");

    // Allow client to release its own resources (sockets, pools, timers)
    if (this.client && typeof this.client.disconnect === "function") {
      try {
        await this.client.disconnect();
      } catch (error) {
        logger.warn(ConnectionStateLogMessages.CLIENT_DISCONNECT_ERROR, String(error));
      }
    }

    this.client = null;
    this.lastError = null;
    this.setState("disconnected");
    logger.info(ConnectionStateLogMessages.DISCONNECTED);
  }

  /**
   * Set connection error state.
   *
   * @param error - The error that occurred
   */
  setError(error: Error): void {
    this.lastError = error;
    this.setState("error", error);
  }

  /**
   * Enable automatic reconnection with exponential backoff.
   *
   * When the connection state transitions to 'error', the manager will
   * automatically attempt to reconnect using the stored client instance.
   * Subsequent attempts use exponential backoff up to `maxDelayMs`.
   *
   * This handles reconnection to the **API backend**, NOT MCP transport
   * reconnection (which is client-side, handled by the SDK's
   * `StreamableHTTPReconnectionOptions`).
   *
   * @param options - Reconnect configuration (all fields optional with sensible defaults)
   */
  enableAutoReconnect(options?: ReconnectOptions): void {
    // Disable any existing reconnect before re-enabling
    this.disableAutoReconnect();

    const maxRetries = options?.maxRetries ?? RECONNECT_DEFAULTS.MAX_RETRIES;
    const initialDelayMs = options?.initialDelayMs ?? RECONNECT_DEFAULTS.INITIAL_DELAY_MS;
    const maxDelayMs = options?.maxDelayMs ?? RECONNECT_DEFAULTS.MAX_DELAY_MS;
    const backoffMultiplier = options?.backoffMultiplier ?? RECONNECT_DEFAULTS.BACKOFF_MULTIPLIER;

    logger.info(ConnectionStateLogMessages.RECONNECT_ENABLED, maxRetries, initialDelayMs, maxDelayMs);

    this._reconnectUnsubscribe = this.onStateChange((state) => {
      if (state === "error" && !this._reconnectAbort) {
        void this.attemptReconnect(maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier);
      }
    });
  }

  /**
   * Disable automatic reconnection.
   * Aborts any in-flight reconnect attempt and removes the listener.
   */
  disableAutoReconnect(): void {
    if (this._reconnectAbort) {
      this._reconnectAbort.abort();
      this._reconnectAbort = null;
    }
    if (this._reconnectUnsubscribe) {
      this._reconnectUnsubscribe();
      this._reconnectUnsubscribe = null;
      logger.info(ConnectionStateLogMessages.RECONNECT_DISABLED);
    }
  }

  /**
   * Internal reconnect loop with exponential backoff.
   */
  private async attemptReconnect(
    maxRetries: number,
    initialDelayMs: number,
    maxDelayMs: number,
    backoffMultiplier: number,
  ): Promise<void> {
    // Abort any previous reconnect loop
    this._reconnectAbort?.abort();
    const abort = new AbortController();
    this._reconnectAbort = abort;

    const client = this.client;
    if (!client) {
      // No client to reconnect with — nothing we can do
      this._reconnectAbort = null;
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (abort.signal.aborted) {
        logger.debug(ConnectionStateLogMessages.RECONNECT_ABORTED);
        this._reconnectAbort = null;
        return;
      }

      const baseDelay = Math.min(initialDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs);
      // Add jitter (±25%) to prevent thundering herd on concurrent reconnects
      const jitter = baseDelay * (0.75 + Math.random() * 0.5);
      const delay = Math.min(jitter, maxDelayMs);
      logger.info(ConnectionStateLogMessages.RECONNECT_ATTEMPT, attempt, maxRetries, Math.round(delay));

      // Wait with abort support
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

      if (abort.signal.aborted) {
        logger.debug(ConnectionStateLogMessages.RECONNECT_ABORTED);
        this._reconnectAbort = null;
        return;
      }

      const success = await this.connect(client);
      if (success) {
        logger.info(ConnectionStateLogMessages.RECONNECT_SUCCESS, attempt);
        this._reconnectAbort = null;
        return;
      }

      logger.warn(
        ConnectionStateLogMessages.RECONNECT_FAILED,
        attempt,
        maxRetries,
        this.lastError?.message ?? "unknown",
      );
    }

    this._reconnectAbort = null;
    logger.error(ConnectionStateLogMessages.RECONNECT_EXHAUSTED, maxRetries);
  }

  /**
   * Clear all listeners.
   * Useful for cleanup during shutdown.
   */
  clearListeners(): void {
    this.listeners.clear();
  }

  /**
   * Reset the connection manager to initial state.
   * Useful for testing or complete reset scenarios.
   */
  reset(): void {
    this.disableAutoReconnect();
    this.state = "disconnected";
    this.client = null;
    this.lastError = null;
    this.listeners.clear();
    // Reset circular buffer
    this.stateHistory = new Array(this.maxHistorySize).fill(null);
    this.historyIndex = 0;
    this.historyCount = 0;
  }

  /**
   * Internal method to update state and notify listeners.
   * Uses circular buffer for O(1) history management.
   * Records metrics for state transitions.
   */
  private setState(newState: ConnectionState, error?: Error): void {
    const previousState = this.state;

    if (previousState === newState) {
      return; // No change
    }

    // Validate state transition (strict — reject invalid transitions)
    const allowed = VALID_STATE_TRANSITIONS[previousState];
    if (allowed && !allowed.includes(newState)) {
      logger.warn(
        ConnectionStateLogMessages.INVALID_TRANSITION,
        previousState,
        newState,
        previousState,
        allowed.join(", "),
      );
      return; // Reject invalid transition
    }

    this.state = newState;

    // Record state transition in metrics
    this.telemetry.recordConnectionStateChange(previousState, newState);

    // Add telemetry event for state change
    this.telemetry.addSpanEvent("connection.state_change", {
      "connection.state.previous": previousState,
      "connection.state.current": newState,
      "connection.error": error?.message,
    });

    const event: ConnectionStateEvent = {
      previousState,
      currentState: newState,
      clientType: this.client?.clientType ?? null,
      error,
      timestamp: new Date(),
    };

    // Add to circular buffer - O(1) operation instead of shift() which is O(n)
    this.stateHistory[this.historyIndex] = event;
    this.historyIndex = (this.historyIndex + 1) % this.maxHistorySize;
    if (this.historyCount < this.maxHistorySize) {
      this.historyCount++;
    }

    logger.trace(ConnectionStateLogMessages.STATE_CHANGE, previousState, newState);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(newState, this.client, error);
      } catch (listenerError) {
        const errorMessage = listenerError instanceof Error ? listenerError.message : String(listenerError);
        logger.error(ConnectionStateLogMessages.LISTENER_ERROR, errorMessage);
      }
    }
  }
}
