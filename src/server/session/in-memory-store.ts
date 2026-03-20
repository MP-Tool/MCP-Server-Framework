/**
 * In-Memory Session Store
 *
 * Built-in session store implementation using a `Map`.
 * Suitable for single-instance deployments.
 *
 * For horizontal scaling, implement the {@link SessionStore} interface
 * with a shared backend (Redis, PostgreSQL, etc.).
 *
 * Contains NO timer logic — background tasks are handled by SessionHousekeeper.
 *
 * @module server/session/in-memory-store
 */

import { logger as baseLogger } from "../../logger/index.js";

import type { TransportType } from "../transport/transport-context.js";
import type { Session, ReadonlySession, SessionCloseReason, CreateSessionOptions } from "./session.js";
import { createSession, SESSION_STATES, SESSION_CLOSE_REASONS } from "./session.js";
import type { SessionStore, SessionStats } from "./session-store.js";

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "session-store";

const LogMessages = {
  SESSION_CREATED: "Session created: %s type=%s (active=%d)",
  SESSION_CLOSED: "Session closed: %s reason=%s (active=%d)",
  SESSION_LIMIT_REACHED: "Session limit reached: %d/%d",
  BROADCAST_TOOL_LIST: "Broadcasting tool list changed to %d sessions",
  BROADCAST_RESOURCE_LIST: "Broadcasting resource list changed to %d sessions",
  BROADCAST_PROMPT_LIST: "Broadcasting prompt list changed to %d sessions",
  SHUTDOWN_STARTED: "Closing all sessions (%d active)",
  SHUTDOWN_COMPLETE: "All sessions closed",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// In-Memory Session Store
// ============================================================================

/**
 * Built-in in-memory session store using a `Map`.
 *
 * Suitable for single-instance deployments. For horizontal scaling,
 * implement the {@link SessionStore} interface with a shared backend.
 *
 * Responsibilities:
 * - Create, get, close, and query sessions
 * - Enforce capacity limits
 * - Track statistics (created, peak, by transport type)
 * - Broadcast notifications to all connected clients
 *
 * Does NOT manage timers or background tasks.
 *
 * @example
 * ```typescript
 * const store = new InMemorySessionStore(100);
 *
 * const session = store.create({ transportType: 'http', transport, mcpSession });
 * const found = store.get(session.id);
 * store.broadcastToolListChanged();
 * await store.close(session.id, SESSION_CLOSE_REASONS.CLIENT_DISCONNECT);
 * ```
 */
export class InMemorySessionStore implements SessionStore {
  /** Active sessions indexed by session ID */
  private readonly sessions = new Map<string, Session>();

  /** Statistics counters */
  private readonly statsCounters = {
    totalCreated: 0,
    peakConcurrent: 0,
    timeoutCount: 0,
    heartbeatFailureCount: 0,
  };

  /** Sessions by transport type (for stats) */
  private readonly byTransportType: Record<TransportType, number> = {
    http: 0,
    https: 0,
    sse: 0,
    stdio: 0,
  };

  /** Whether the store is rejecting new sessions */
  private isShuttingDown = false;

  constructor(private readonly maxSessions: number) {}

  // ==========================================================================
  // Properties
  // ==========================================================================

  get size(): number {
    return this.sessions.size;
  }

  get stats(): SessionStats {
    return {
      activeCount: this.sessions.size,
      maxSessions: this.maxSessions,
      totalCreated: this.statsCounters.totalCreated,
      peakConcurrent: this.statsCounters.peakConcurrent,
      timeoutCount: this.statsCounters.timeoutCount,
      heartbeatFailureCount: this.statsCounters.heartbeatFailureCount,
      byTransportType: { ...this.byTransportType },
    };
  }

  // ==========================================================================
  // CRUD Operations
  // ==========================================================================

  /**
   * Creates and registers a new session.
   *
   * Capacity check and insertion are synchronous (no await between them),
   * which is safe in Node.js single-threaded event loop. Do NOT introduce
   * any async operations between hasCapacity() and sessions.set().
   *
   * @param options - Session creation options
   * @returns The created session, or undefined if at max capacity or shutting down
   */
  create(options: CreateSessionOptions): Session | undefined {
    if (this.isShuttingDown || this.sessions.size >= this.maxSessions) {
      if (!this.isShuttingDown) {
        logger.warn(LogMessages.SESSION_LIMIT_REACHED, this.sessions.size, this.maxSessions);
      }
      return undefined;
    }

    // IMPORTANT: No await between capacity check above and Map.set() below.
    // This keeps the check-and-insert atomic within the same microtask.
    const session = createSession(options);
    session.state = SESSION_STATES.ACTIVE;

    this.sessions.set(session.id, session);

    // Update statistics
    this.statsCounters.totalCreated++;
    this.byTransportType[session.transport.type]++;
    if (this.sessions.size > this.statsCounters.peakConcurrent) {
      this.statsCounters.peakConcurrent = this.sessions.size;
    }

    logger.info(LogMessages.SESSION_CREATED, session.id, session.transport.type, this.sessions.size);

    return session;
  }

  /**
   * Gets an active session by ID.
   * Does NOT update activity time (use touch() for that).
   */
  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (session && session.state === SESSION_STATES.ACTIVE) {
      return session;
    }
    return undefined;
  }

  /**
   * Checks if a session exists and is active.
   */
  has(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && session.state === SESSION_STATES.ACTIVE;
  }

  /**
   * Updates the last activity time for a session.
   * Also resets missed heartbeat count.
   */
  touch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session && session.state === SESSION_STATES.ACTIVE) {
      session.metadata.lastActivityAt = new Date();
      session.transport.heartbeat = {
        ...session.transport.heartbeat,
        missedCount: 0,
      };
      return true;
    }
    return false;
  }

  /**
   * Checks if there's capacity for new sessions.
   */
  hasCapacity(): boolean {
    return this.sessions.size < this.maxSessions;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Removes a session from the store and updates statistics.
   *
   * Pure data operation — does NOT close transport or dispose MCP session.
   * The caller (SessionManager) is responsible for I/O teardown.
   *
   * @param sessionId - Session identifier
   * @param reason - Reason for closure (tracked in stats)
   * @returns The removed session, or undefined if not found
   */
  remove(sessionId: string, reason: SessionCloseReason): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    // Track close reason in stats
    if (reason === SESSION_CLOSE_REASONS.TIMEOUT) {
      this.statsCounters.timeoutCount++;
    } else if (reason === SESSION_CLOSE_REASONS.HEARTBEAT_FAILURE) {
      this.statsCounters.heartbeatFailureCount++;
    }

    session.state = SESSION_STATES.CLOSING;
    this.byTransportType[session.transport.type]--;
    this.sessions.delete(sessionId);

    logger.info(LogMessages.SESSION_CLOSED, sessionId, reason, this.sessions.size);

    return session;
  }

  /**
   * Removes all sessions from the store during shutdown.
   * Returns the removed sessions for the caller to handle I/O teardown.
   */
  removeAll(): Session[] {
    this.isShuttingDown = true;
    const sessionCount = this.sessions.size;

    logger.info(LogMessages.SHUTDOWN_STARTED, sessionCount);

    const removed: Session[] = [];
    for (const sessionId of Array.from(this.sessions.keys())) {
      const session = this.remove(sessionId, SESSION_CLOSE_REASONS.SHUTDOWN);
      if (session) {
        removed.push(session);
      }
    }

    logger.info(LogMessages.SHUTDOWN_COMPLETE);
    return removed;
  }

  /**
   * Marks the store as shutting down (rejects new sessions).
   */
  markShuttingDown(): void {
    this.isShuttingDown = true;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Iterates over all active sessions.
   */
  forEach(callback: (session: ReadonlySession, sessionId: string) => void): void {
    for (const session of this.sessions.values()) {
      callback(session, session.id);
    }
  }

  /**
   * Finds sessions matching a predicate.
   */
  filter(predicate: (session: ReadonlySession) => boolean): ReadonlySession[] {
    const results: ReadonlySession[] = [];
    for (const session of this.sessions.values()) {
      if (predicate(session)) {
        results.push(session);
      }
    }
    return results;
  }

  /**
   * Gets all sessions of a specific transport type.
   */
  getByTransportType(type: TransportType): ReadonlySession[] {
    return this.filter((session) => session.transport.type === type);
  }

  // ==========================================================================
  // Broadcasting
  // ==========================================================================

  /**
   * Broadcasts tool list changed notification to all active sessions.
   */
  broadcastToolListChanged(): void {
    this.broadcastToSessions(LogMessages.BROADCAST_TOOL_LIST, (sdk) => sdk.sendToolListChanged());
  }

  broadcastResourceListChanged(): void {
    this.broadcastToSessions(LogMessages.BROADCAST_RESOURCE_LIST, (sdk) => sdk.sendResourceListChanged());
  }

  broadcastPromptListChanged(): void {
    this.broadcastToSessions(LogMessages.BROADCAST_PROMPT_LIST, (sdk) => sdk.sendPromptListChanged());
  }

  broadcastResourceUpdated(uri: string): void {
    const activeCount = this.sessions.size;
    if (activeCount === 0) {
      return;
    }

    for (const session of this.sessions.values()) {
      if (session.state === SESSION_STATES.ACTIVE) {
        // Delegate to McpSession which checks subscription state
        session.mcpSession.sendResourceUpdated(uri).catch((error: unknown) => {
          logger.warn("Error sending resource updated to session %s: %s", session.id, String(error));
        });
      }
    }
  }

  /**
   * Broadcasts a notification to all active sessions.
   * @internal
   */
  private broadcastToSessions(
    logMessage: string,
    action: (sdk: Session["mcpSession"]["sdk"]) => void | Promise<void>,
  ): void {
    const activeCount = this.sessions.size;
    if (activeCount === 0) {
      return;
    }

    logger.trace(logMessage, activeCount);

    for (const session of this.sessions.values()) {
      if (session.state === SESSION_STATES.ACTIVE) {
        try {
          const result = action(session.mcpSession.sdk);
          if (result instanceof Promise) {
            result.catch((error: unknown) => {
              logger.warn("Error broadcasting to session %s: %s", session.id, String(error));
            });
          }
        } catch (error) {
          logger.warn("Error broadcasting to session %s: %s", session.id, String(error));
        }
      }
    }
  }
}
