/**
 * Session Housekeeper
 *
 * Background task manager for session maintenance.
 * Handles periodic cleanup of expired sessions and heartbeat monitoring.
 *
 * Contains NO CRUD logic — session operations are delegated to SessionStore.
 *
 * @module server/session/session-housekeeper
 */

import { logger as baseLogger } from "../../logger/index.js";

import { isHeartbeatCapable } from "../transport/transport-context.js";
import { SESSION_STATES, SESSION_CLOSE_REASONS } from "./session.js";
import type { SessionCloseReason } from "./session.js";
import type { SessionStore } from "./session-store.js";

/**
 * Callback for the Housekeeper to request session closure.
 * Implemented by SessionManager which owns the full teardown lifecycle.
 * Returns void or Promise<void> to support async teardown.
 */
export type CloseSessionCallback = (sessionId: string, reason: SessionCloseReason) => void | Promise<void>;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the session housekeeper.
 */
export interface HousekeeperConfig {
  /** Session timeout in milliseconds (default: 30 minutes) */
  readonly timeoutMs: number;

  /** Cleanup interval in milliseconds (0 = disabled) */
  readonly cleanupIntervalMs: number;

  /** Keep-alive interval in milliseconds (0 = disabled) */
  readonly keepAliveIntervalMs: number;

  /** Max missed heartbeats before disconnect (default: 3) */
  readonly maxMissedHeartbeats: number;
}

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "session-housekeeper";

const LogMessages = {
  STARTED: "Housekeeper started (timeout=%dmin, cleanup=%ds, heartbeat=%ds)",
  SESSION_EXPIRED: "Session expired: %s (idle=%dms)",
  SESSION_HEARTBEAT_FAILED: "Session heartbeat failed: %s (missed=%d)",
  SESSION_CLOSE_ERROR: "Error closing session %s during %s: %s",
  CLEANUP_CYCLE: "Cleanup cycle: expired=%d remaining=%d",
  HEARTBEAT_CYCLE: "Heartbeat cycle: success=%d failed=%d removed=%d",
  DISPOSED: "Housekeeper disposed",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Session Housekeeper
// ============================================================================

/**
 * Manages periodic background tasks for session maintenance.
 *
 * Responsibilities:
 * - Cleanup expired (idle) sessions at regular intervals
 * - Send heartbeats and remove dead connections
 *
 * Timers are configured at construction and use `.unref()` to
 * not prevent Node.js process exit.
 *
 * For stdio mode, pass `cleanupIntervalMs: 0` and `keepAliveIntervalMs: 0`
 * to disable all background tasks.
 *
 * @example
 * ```typescript
 * const housekeeper = new SessionHousekeeper(store, {
 *   timeoutMs: 30 * 60_000,
 *   cleanupIntervalMs: 60_000,
 *   keepAliveIntervalMs: 30_000,
 *   maxMissedHeartbeats: 3,
 * });
 *
 * // Later during shutdown:
 * housekeeper.dispose();
 * ```
 */
export class SessionHousekeeper {
  /** Cleanup interval timer */
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Keep-alive interval timer */
  private keepAliveInterval: NodeJS.Timeout | null = null;

  /** Whether the housekeeper is stopped */
  private disposed = false;

  constructor(
    private readonly store: SessionStore,
    private readonly config: HousekeeperConfig,
    private readonly onCloseSession: CloseSessionCallback,
  ) {
    this.startTimers();

    logger.trace(
      LogMessages.STARTED,
      Math.round(this.config.timeoutMs / 60000),
      Math.round(this.config.cleanupIntervalMs / 1000),
      Math.round(this.config.keepAliveIntervalMs / 1000),
    );
  }

  /**
   * Stops all background timers and marks as disposed.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    logger.trace(LogMessages.DISPOSED);
  }

  // ==========================================================================
  // Timer Management
  // ==========================================================================

  /**
   * Starts cleanup and heartbeat interval timers.
   *
   * Timers are only started when the corresponding interval is > 0.
   * This allows stdio mode to skip background tasks entirely.
   * Timers use .unref() to not prevent Node.js process exit.
   */
  private startTimers(): void {
    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupInterval = setInterval(() => {
        void this.runCleanupCycle();
      }, this.config.cleanupIntervalMs);
      this.cleanupInterval.unref();
    }

    if (this.config.keepAliveIntervalMs > 0) {
      this.keepAliveInterval = setInterval(() => {
        void this.runHeartbeatCycle();
      }, this.config.keepAliveIntervalMs);
      this.keepAliveInterval.unref();
    }
  }

  // ==========================================================================
  // Cleanup Cycle
  // ==========================================================================

  /**
   * Runs a cleanup cycle to remove expired sessions.
   *
   * Iterates all sessions and closes those that have been idle
   * longer than the configured timeout.
   */
  private async runCleanupCycle(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const now = Date.now();
    const expiredIds: string[] = [];

    this.store.forEach((session) => {
      if (session.state !== SESSION_STATES.ACTIVE) {
        return;
      }

      const idleTime = now - session.metadata.lastActivityAt.getTime();
      if (idleTime > this.config.timeoutMs) {
        expiredIds.push(session.id);
        logger.debug(LogMessages.SESSION_EXPIRED, session.id, idleTime);
      }
    });

    const results = await Promise.allSettled(
      expiredIds.map((sessionId) => Promise.resolve(this.onCloseSession(sessionId, SESSION_CLOSE_REASONS.TIMEOUT))),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i]?.status === "rejected") {
        // @ts-limitation — TS narrows status to 'rejected' but not the union discriminant on results[i]
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.warn(LogMessages.SESSION_CLOSE_ERROR, expiredIds[i], "cleanup", String(reason));
      }
    }

    if (expiredIds.length > 0) {
      logger.trace(LogMessages.CLEANUP_CYCLE, expiredIds.length, this.store.size);
    }
  }

  // ==========================================================================
  // Heartbeat Cycle
  // ==========================================================================

  /**
   * Runs a heartbeat cycle to check connection health.
   *
   * Sends heartbeats to all sessions with heartbeat-capable transports.
   * Sessions that exceed the maximum missed heartbeats are closed.
   *
   * NOTE: Heartbeat state mutations (missedCount, lastSuccessAt) are synchronous
   * within the forEach callback — no async gap between read and write.
   * This is safe in Node.js single-threaded event loop.
   */
  private async runHeartbeatCycle(): Promise<void> {
    if (this.disposed) {
      return;
    }

    let successCount = 0;
    let failedCount = 0;
    const toRemove: string[] = [];

    this.store.forEach((session) => {
      if (session.state !== SESSION_STATES.ACTIVE) {
        return;
      }

      const transport = session.transport.instance;

      if (!isHeartbeatCapable(transport)) {
        return;
      }

      const success = transport.sendHeartbeat();

      if (success) {
        successCount++;
        session.metadata.lastActivityAt = new Date();
        session.transport.heartbeat = {
          ...session.transport.heartbeat,
          missedCount: 0,
          lastSuccessAt: new Date(),
        };
      } else {
        failedCount++;
        const newMissedCount = session.transport.heartbeat.missedCount + 1;
        session.transport.heartbeat = {
          ...session.transport.heartbeat,
          missedCount: newMissedCount,
        };

        if (newMissedCount >= this.config.maxMissedHeartbeats) {
          toRemove.push(session.id);
          logger.debug(LogMessages.SESSION_HEARTBEAT_FAILED, session.id, newMissedCount);
        }
      }
    });

    const results = await Promise.allSettled(
      toRemove.map((sessionId) =>
        Promise.resolve(this.onCloseSession(sessionId, SESSION_CLOSE_REASONS.HEARTBEAT_FAILURE)),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i]?.status === "rejected") {
        // @ts-limitation — TS narrows status to 'rejected' but not the union discriminant on results[i]
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.warn(LogMessages.SESSION_CLOSE_ERROR, toRemove[i], "heartbeat", String(reason));
      }
    }

    if (successCount > 0 || failedCount > 0) {
      logger.trace(LogMessages.HEARTBEAT_CYCLE, successCount, failedCount, toRemove.length);
    }
  }
}
