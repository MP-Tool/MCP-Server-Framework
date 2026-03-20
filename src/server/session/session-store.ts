/**
 * Session Store
 *
 * Interface definition for session CRUD storage and lifecycle management.
 *
 * Contains NO implementation — the built-in in-memory implementation is in
 * `in-memory-store.ts`. Consumers can implement this interface with Redis,
 * PostgreSQL, or another shared backend for horizontal scaling.
 *
 * @module server/session/session-store
 */

import type { TransportType } from "../transport/transport-context.js";
import type { Session, ReadonlySession, SessionCloseReason, CreateSessionOptions } from "./session.js";

// ============================================================================
// Session Statistics
// ============================================================================

/**
 * Statistics about session store state.
 */
export interface SessionStats {
  /** Currently active sessions */
  readonly activeCount: number;

  /** Maximum allowed sessions */
  readonly maxSessions: number;

  /** Total sessions created since startup */
  readonly totalCreated: number;

  /** Peak concurrent sessions */
  readonly peakConcurrent: number;

  /** Sessions closed due to timeout */
  readonly timeoutCount: number;

  /** Sessions closed due to heartbeat failure */
  readonly heartbeatFailureCount: number;

  /** Breakdown by transport type */
  readonly byTransportType: Readonly<Record<TransportType, number>>;
}

// ============================================================================
// Session Store Interface
// ============================================================================

/**
 * Interface for session CRUD storage and lifecycle management.
 *
 * The built-in {@link InMemorySessionStore} uses a `Map` and is
 * suitable for single-instance deployments.
 *
 * For horizontal scaling across multiple server instances, implement
 * this interface with a shared backend (e.g., Redis, PostgreSQL).
 *
 * @example Custom implementation
 * ```typescript
 * class RedisSessionStore implements SessionStore {
 *   // ... implement all methods with Redis as the backend
 * }
 *
 * const manager = new SessionManagerImpl({
 *   store: new RedisSessionStore(redisClient),
 * });
 * ```
 */
export interface SessionStore {
  /** Number of active sessions */
  readonly size: number;

  /** Current statistics */
  readonly stats: SessionStats;

  /** Creates and registers a new session */
  create(options: CreateSessionOptions): Session | undefined;

  /** Gets an active session by ID (does NOT update activity time) */
  get(sessionId: string): Session | undefined;

  /** Checks if a session exists and is active */
  has(sessionId: string): boolean;

  /** Updates the last activity time for a session */
  touch(sessionId: string): boolean;

  /** Checks if there's capacity for new sessions */
  hasCapacity(): boolean;

  /** Removes a session from the store and updates statistics */
  remove(sessionId: string, reason: SessionCloseReason): Session | undefined;

  /** Removes all sessions during shutdown */
  removeAll(): Session[];

  /** Marks the store as shutting down (rejects new sessions) */
  markShuttingDown(): void;

  /** Iterates over all active sessions */
  forEach(callback: (session: ReadonlySession, sessionId: string) => void): void;

  /** Finds sessions matching a predicate */
  filter(predicate: (session: ReadonlySession) => boolean): ReadonlySession[];

  /** Gets all sessions of a specific transport type */
  getByTransportType(type: TransportType): ReadonlySession[];

  /** Broadcasts tool list changed notification to all active sessions */
  broadcastToolListChanged(): void;

  /** Broadcasts resource list changed notification to all active sessions */
  broadcastResourceListChanged(): void;

  /** Broadcasts prompt list changed notification to all active sessions */
  broadcastPromptListChanged(): void;

  /**
   * Sends a resource updated notification to sessions subscribed to the given URI.
   *
   * Unlike list-changed broadcasts (sent to all sessions), this only notifies
   * sessions that have subscribed to the specific resource URI via
   * `resources/subscribe`.
   */
  broadcastResourceUpdated(uri: string): void;
}
