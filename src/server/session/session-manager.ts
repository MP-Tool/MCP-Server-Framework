/**
 * Session Manager
 *
 * Facade over SessionStore (CRUD) and SessionHousekeeper (timers).
 * Provides the unified SessionManager interface to consumers.
 *
 * The SessionManager interface is the public contract — consumers
 * never interact with Store or Housekeeper directly.
 *
 * @module server/session/session-manager
 */

import { getFrameworkConfig } from "../../config/index.js";
import { logger as baseLogger, mcpLogger } from "../../logger/index.js";

import type { TransportType } from "../transport/transport-context.js";
import type { Session, ReadonlySession, SessionCloseReason, CreateSessionOptions } from "./session.js";
import { getServerMetrics } from "../../telemetry/index.js";
import { InMemorySessionStore } from "./in-memory-store.js";
import type { SessionStore, SessionStats } from "./session-store.js";
import { SessionHousekeeper } from "./session-housekeeper.js";
import { SESSION_STATES } from "./session.js";

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Configuration for session management.
 */
export interface SessionConfig {
  /** Session timeout in milliseconds (default: 30 minutes) */
  readonly timeoutMs: number;

  /** Cleanup interval in milliseconds (default: 60 seconds) */
  readonly cleanupIntervalMs: number;

  /** Keep-alive interval in milliseconds (default: 30 seconds) */
  readonly keepAliveIntervalMs: number;

  /** Max missed heartbeats before disconnect (default: 3) */
  readonly maxMissedHeartbeats: number;

  /** Maximum total concurrent sessions across all transports (default: 200) */
  readonly maxSessions: number;

  /** Maximum concurrent Streamable HTTP sessions (default: 100) */
  readonly maxStreamableHttpSessions: number;

  /** Maximum concurrent SSE sessions (default: 50) */
  readonly maxSseSessions: number;
}

/**
 * Partial config for user overrides.
 */
export type SessionConfigInput = Partial<SessionConfig> & {
  /** Optional lifecycle hooks for client connect/disconnect events */
  readonly lifecycle?: SessionLifecycleHooks | undefined;

  /**
   * Custom session store implementation.
   *
   * When provided, replaces the built-in {@link InMemorySessionStore}.
   * Useful for horizontal scaling with Redis, PostgreSQL, or another
   * shared backend.
   *
   * The store must implement the {@link SessionStore} interface.
   */
  readonly store?: SessionStore | undefined;
};

/**
 * Lifecycle hooks for session-level events.
 *
 * These hooks are called by the SessionManager when sessions are
 * created or closed, enabling connection tracking in consumer code.
 */
export interface SessionLifecycleHooks {
  /** Called after a new session is successfully created */
  readonly onClientConnected?: ((sessionId: string) => void | Promise<void>) | undefined;
  /** Called after a session is closed and cleaned up */
  readonly onClientDisconnected?: ((sessionId: string) => void | Promise<void>) | undefined;
}

// ============================================================================
// Session Manager Interface
// ============================================================================

// Re-export SessionStats from the store (keeps the public API unchanged)
export type { SessionStats } from "./session-store.js";

/**
 * Interface for managing sessions.
 *
 * Provides unified session lifecycle management for all transport types.
 * Supports heartbeat monitoring, automatic cleanup, and broadcasting.
 */
export interface SessionManager {
  /** Number of active sessions */
  readonly size: number;

  /** Current statistics */
  readonly stats: SessionStats;

  /**
   * Creates and registers a new session.
   *
   * @param options - Session creation options
   * @returns The created session, or undefined if at capacity
   */
  create(options: CreateSessionOptions): Session | undefined;

  /**
   * Gets a session by ID.
   * Does NOT update activity time (use touch() for that).
   *
   * @param sessionId - Session identifier
   * @returns The session if found and active
   */
  get(sessionId: string): Session | undefined;

  /**
   * Checks if a session exists and is active.
   *
   * @param sessionId - Session identifier
   */
  has(sessionId: string): boolean;

  /**
   * Updates the last activity time for a session.
   * Also resets missed heartbeat count.
   *
   * @param sessionId - Session identifier
   * @returns true if session was touched
   */
  touch(sessionId: string): boolean;

  /**
   * Checks if there's capacity for new sessions.
   */
  hasCapacity(): boolean;

  /**
   * Checks if there's capacity for a specific transport type.
   * Enforces per-transport limits (e.g., maxStreamableHttpSessions, maxSseSessions).
   *
   * @param transportType - The transport type to check capacity for
   */
  hasCapacityForTransport(transportType: TransportType): boolean;

  /**
   * Closes and removes a specific session.
   *
   * @param sessionId - Session identifier
   * @param reason - Reason for closure
   */
  close(sessionId: string, reason: SessionCloseReason): Promise<void>;

  /**
   * Closes all sessions during shutdown.
   */
  closeAll(): Promise<void>;

  /**
   * Broadcasts tool list changed notification to all sessions.
   * Called when dynamic tools are added/removed.
   */
  broadcastToolListChanged(): void;

  /**
   * Broadcasts resource list changed notification to all sessions.
   * Called when dynamic resources are added/removed.
   */
  broadcastResourceListChanged(): void;

  /**
   * Broadcasts prompt list changed notification to all sessions.
   * Called when dynamic prompts are added/removed.
   */
  broadcastPromptListChanged(): void;

  /**
   * Sends a resource updated notification to sessions subscribed to the given URI.
   *
   * Only sessions that have called `resources/subscribe` for this URI receive
   * the `notifications/resources/updated` notification.
   */
  broadcastResourceUpdated(uri: string): void;

  /**
   * Iterates over all active sessions.
   *
   * @param callback - Function to call for each session
   */
  forEach(callback: (session: ReadonlySession, sessionId: string) => void): void;

  /**
   * Finds sessions matching a predicate.
   *
   * @param predicate - Filter function
   * @returns Array of matching sessions
   */
  filter(predicate: (session: ReadonlySession) => boolean): ReadonlySession[];

  /**
   * Gets all sessions of a specific transport type.
   *
   * @param type - Transport type to filter by
   */
  getByTransportType(type: TransportType): ReadonlySession[];

  /**
   * Disposes of the manager and stops background tasks.
   */
  dispose(): void;
}

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "session-manager";

const LogMessages = {
  MANAGER_STARTED: "Session manager started (timeout=%dmin, cleanup=%ds, heartbeat=%ds)",
  SESSION_CREATED: "Session created: id=%s, transport=%s",
  SESSION_CAPACITY_FULL: "Session capacity reached — rejecting new session (%d/%d)",
  SESSION_CLOSED: "Session closed: id=%s, reason=%s",
  CLOSING_ALL: "Closing all sessions (%d active)",
  MANAGER_DISPOSED: "Session manager disposed",
  BROADCAST_TOOL_LIST: "Broadcasting tool list changed to %d session(s)",
  BROADCAST_RESOURCE_LIST: "Broadcasting resource list changed to %d session(s)",
  BROADCAST_PROMPT_LIST: "Broadcasting prompt list changed to %d session(s)",
  TRANSPORT_CLOSE_ERROR: "Error closing transport for session %s",
  SESSION_DISPOSE_ERROR: "Error disposing MCP session %s",
  LIFECYCLE_HOOK_ERROR: "Lifecycle hook %s failed for session %s: %s",
  CLOSE_ALL_COMPLETE: "All sessions closed (%d sessions torn down)",
  SESSION_TRANSPORT_LIMIT: "Session limit reached for transport %s: %d/%d",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default session timing values.
 *
 * These are hardcoded defaults — session timing is only configurable
 * via the programmatic API (`SessionConfigOptions`), not via
 * environment variables or config files.
 */
const SESSION_TIMING_DEFAULTS = {
  TIMEOUT_MS: 1_800_000, // 30 minutes
  CLEANUP_INTERVAL_MS: 60_000, // 1 minute
  KEEP_ALIVE_INTERVAL_MS: 30_000, // 30 seconds
  MAX_MISSED_HEARTBEATS: 3,
} as const;

/**
 * Creates the default session configuration.
 *
 * Timing values use hardcoded defaults (configurable only programmatically).
 * Session limits are read from `getFrameworkConfig()` which respects all
 * config sources: Zod defaults → .env → env vars → config file → overrides.
 */
function createDefaultConfig(): SessionConfig {
  const config = getFrameworkConfig();
  return {
    timeoutMs: SESSION_TIMING_DEFAULTS.TIMEOUT_MS,
    cleanupIntervalMs: SESSION_TIMING_DEFAULTS.CLEANUP_INTERVAL_MS,
    keepAliveIntervalMs: SESSION_TIMING_DEFAULTS.KEEP_ALIVE_INTERVAL_MS,
    maxMissedHeartbeats: SESSION_TIMING_DEFAULTS.MAX_MISSED_HEARTBEATS,
    maxSessions: config.MCP_MAX_SESSIONS,
    maxStreamableHttpSessions: config.MCP_MAX_STREAMABLE_HTTP_SESSIONS,
    maxSseSessions: config.MCP_MAX_SSE_SESSIONS,
  };
}

// ============================================================================
// Implementation (Facade)
// ============================================================================

/**
 * Facade implementation of SessionManager.
 *
 * Delegates to:
 * - {@link SessionStore} for CRUD operations, queries, and broadcasting
 * - {@link SessionHousekeeper} for background cleanup and heartbeat monitoring
 *
 * @example
 * ```typescript
 * // HTTP mode — full background tasks
 * const manager = new SessionManagerImpl();
 *
 * // Stdio mode — no background tasks
 * const manager = new SessionManagerImpl({
 *   cleanupIntervalMs: 0,
 *   keepAliveIntervalMs: 0,
 *   maxSessions: 1,
 * });
 * ```
 */
export class SessionManagerImpl implements SessionManager {
  private readonly store: SessionStore;
  private readonly housekeeper: SessionHousekeeper;
  private readonly config: SessionConfig;
  private readonly lifecycle?: SessionLifecycleHooks | undefined;

  constructor(config?: SessionConfigInput) {
    const { lifecycle, store, ...configOverrides } = config ?? {};
    const defaults = createDefaultConfig();
    this.config = { ...defaults, ...configOverrides };
    this.lifecycle = lifecycle;

    this.store = store ?? new InMemorySessionStore(this.config.maxSessions);
    this.housekeeper = new SessionHousekeeper(
      this.store,
      {
        timeoutMs: this.config.timeoutMs,
        cleanupIntervalMs: this.config.cleanupIntervalMs,
        keepAliveIntervalMs: this.config.keepAliveIntervalMs,
        maxMissedHeartbeats: this.config.maxMissedHeartbeats,
      },
      (sessionId, reason) => this.close(sessionId, reason),
    );

    logger.trace(
      LogMessages.MANAGER_STARTED,
      Math.round(this.config.timeoutMs / 60000),
      Math.round(this.config.cleanupIntervalMs / 1000),
      Math.round(this.config.keepAliveIntervalMs / 1000),
    );
  }

  // ==========================================================================
  // Delegated Properties
  // ==========================================================================

  get size(): number {
    return this.store.size;
  }

  get stats(): SessionStats {
    return this.store.stats;
  }

  // ==========================================================================
  // Delegated CRUD
  // ==========================================================================

  create(options: CreateSessionOptions): Session | undefined {
    // Check per-transport limits before delegating to store
    if (!this.hasCapacityForTransport(options.transportType)) {
      return undefined;
    }

    const session = this.store.create(options);
    if (session) {
      mcpLogger.addHandler(session.mcpSession);
      getServerMetrics().recordSessionChange(session.transport.type, 1);
      logger.debug(LogMessages.SESSION_CREATED, session.id, session.transport.type);
      void this.invokeLifecycleHook("onClientConnected", session.id, () =>
        this.lifecycle?.onClientConnected?.(session.id),
      );
    } else {
      logger.info(LogMessages.SESSION_CAPACITY_FULL, this.store.size, this.config.maxSessions);
    }
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.store.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.store.has(sessionId);
  }

  touch(sessionId: string): boolean {
    return this.store.touch(sessionId);
  }

  hasCapacity(): boolean {
    return this.store.hasCapacity();
  }

  /**
   * Checks if there's capacity for a specific transport type.
   * Enforces per-transport limits from config.
   */
  hasCapacityForTransport(transportType: TransportType): boolean {
    if (transportType === "http" || transportType === "https") {
      const count = this.store.getByTransportType("http").length + this.store.getByTransportType("https").length;
      if (count >= this.config.maxStreamableHttpSessions) {
        logger.warn(
          LogMessages.SESSION_TRANSPORT_LIMIT,
          "streamable-http",
          count,
          this.config.maxStreamableHttpSessions,
        );
        return false;
      }
    } else if (transportType === "sse") {
      const count = this.store.getByTransportType("sse").length;
      if (count >= this.config.maxSseSessions) {
        logger.warn(LogMessages.SESSION_TRANSPORT_LIMIT, "sse", count, this.config.maxSseSessions);
        return false;
      }
    }
    // stdio has no per-transport limit
    return true;
  }

  // ==========================================================================
  // Lifecycle (Manager owns I/O teardown)
  // ==========================================================================

  async close(sessionId: string, reason: SessionCloseReason): Promise<void> {
    const session = this.store.remove(sessionId, reason);
    if (!session) {
      return;
    }

    getServerMetrics().recordSessionChange(session.transport.type, -1);
    mcpLogger.removeHandler(session.mcpSession);
    logger.debug(LogMessages.SESSION_CLOSED, sessionId, reason);

    try {
      await session.transport.instance.close();
    } catch (error) {
      logger.warn(LogMessages.TRANSPORT_CLOSE_ERROR, sessionId, { error });
    }

    try {
      await session.mcpSession.dispose();
    } catch (error) {
      logger.warn(LogMessages.SESSION_DISPOSE_ERROR, sessionId, { error });
    }

    session.state = SESSION_STATES.CLOSED;
    await this.invokeLifecycleHook("onClientDisconnected", sessionId, () =>
      this.lifecycle?.onClientDisconnected?.(sessionId),
    );
  }

  async closeAll(): Promise<void> {
    const sessions = this.store.removeAll();
    logger.info(LogMessages.CLOSING_ALL, sessions.length);

    const teardownPromises = sessions.map(async (session) => {
      getServerMetrics().recordSessionChange(session.transport.type, -1);
      mcpLogger.removeHandler(session.mcpSession);

      try {
        await session.transport.instance.close();
      } catch (error) {
        logger.warn(LogMessages.TRANSPORT_CLOSE_ERROR, session.id, { error });
      }

      try {
        await session.mcpSession.dispose();
      } catch (error) {
        logger.warn(LogMessages.SESSION_DISPOSE_ERROR, session.id, { error });
      }

      session.state = SESSION_STATES.CLOSED;
      await this.invokeLifecycleHook("onClientDisconnected", session.id, () =>
        this.lifecycle?.onClientDisconnected?.(session.id),
      );
    });

    await Promise.allSettled(teardownPromises);
    logger.debug(LogMessages.CLOSE_ALL_COMPLETE, sessions.length);
  }

  dispose(): void {
    this.housekeeper.dispose();
    this.store.markShuttingDown();
    logger.debug(LogMessages.MANAGER_DISPOSED);
  }

  // ==========================================================================
  // Delegated Queries
  // ==========================================================================

  forEach(callback: (session: ReadonlySession, sessionId: string) => void): void {
    this.store.forEach(callback);
  }

  filter(predicate: (session: ReadonlySession) => boolean): ReadonlySession[] {
    return this.store.filter(predicate);
  }

  getByTransportType(type: TransportType): ReadonlySession[] {
    return this.store.getByTransportType(type);
  }

  // ==========================================================================
  // Delegated Broadcasting
  // ==========================================================================

  broadcastToolListChanged(): void {
    logger.trace(LogMessages.BROADCAST_TOOL_LIST, this.store.size);
    this.store.broadcastToolListChanged();
  }

  broadcastResourceListChanged(): void {
    logger.trace(LogMessages.BROADCAST_RESOURCE_LIST, this.store.size);
    this.store.broadcastResourceListChanged();
  }

  broadcastPromptListChanged(): void {
    logger.trace(LogMessages.BROADCAST_PROMPT_LIST, this.store.size);
    this.store.broadcastPromptListChanged();
  }

  broadcastResourceUpdated(uri: string): void {
    this.store.broadcastResourceUpdated(uri);
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  /**
   * Invokes a lifecycle hook with error logging.
   * Hook errors are logged as warnings but never propagated.
   * Async hooks are awaited so shutdown waits for consumer cleanup.
   */
  private async invokeLifecycleHook(name: string, sessionId: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(LogMessages.LIFECYCLE_HOOK_ERROR, name, sessionId, msg);
    }
  }
}
