/**
 * Server Lifecycle Types
 *
 * Defines lifecycle hooks and state management for MCP servers.
 * These types enable clean startup/shutdown handling and event-driven architecture.
 *
 * @module server/lifecycle
 */

// ============================================================================
// Lifecycle State Types
// ============================================================================

/**
 * Server lifecycle states.
 *
 * State machine:
 * ```
 * created → starting → running → stopping → stopped
 *                ↓         ↓
 *              error ←────┘
 * ```
 */
export type ServerState = "created" | "starting" | "running" | "stopping" | "stopped" | "error";

/**
 * All possible server states as a readonly array.
 *
 * @public Exported for consumer validation and iteration.
 * The {@link ServerState} type is the recommended way to type state values.
 */
export const SERVER_STATES = ["created", "starting", "running", "stopping", "stopped", "error"] as const;

// ============================================================================
// Lifecycle Hooks Interface
// ============================================================================

/**
 * Lifecycle hooks for MCP servers.
 *
 * Implement these hooks to execute code at specific points in the server lifecycle.
 * All hooks are optional and async-friendly.
 *
 * @example
 * ```typescript
 * const hooks: ServerLifecycleHooks = {
 *   onStarting: async () => {
 *     await initializeDatabase();
 *   },
 *   onStarted: async () => {
 *     logger.info('Server is ready');
 *   },
 *   onStopping: async () => {
 *     await flushMetrics();
 *   },
 *   onStopped: async () => {
 *     await closeConnections();
 *   },
 * };
 * ```
 */
export interface ServerLifecycleHooks {
  /**
   * Called before server starts accepting connections.
   * Use for initialization tasks (database, cache, external services).
   */
  onStarting?: () => void | Promise<void>;

  /**
   * Called after server is fully started and accepting connections.
   * Use for logging, metrics, or notifying external systems.
   */
  onStarted?: () => void | Promise<void>;

  /**
   * Called when server begins shutdown process.
   * Use for graceful cleanup (flush buffers, notify clients).
   */
  onStopping?: () => void | Promise<void>;

  /**
   * Called after server has fully stopped.
   * Use for final cleanup (close file handles, database connections).
   */
  onStopped?: () => void | Promise<void>;

  /**
   * Called when an unhandled error occurs.
   * Use for error reporting/logging.
   */
  onError?: (error: Error) => void | Promise<void>;

  /**
   * Called when a client connects to the server.
   * Use for session initialization or connection tracking.
   *
   * **Important:** This hook is invoked asynchronously (fire-and-forget) during
   * session creation. It is NOT awaited — the session is returned to the transport
   * before this hook completes. For async setup that must finish before the session
   * handles requests, use the tool/resource handlers themselves.
   *
   * During session close, {@link onClientDisconnected} IS awaited.
   */
  onClientConnected?: (sessionId: string) => void | Promise<void>;

  /**
   * Called when a client disconnects from the server.
   * Use for session cleanup or connection tracking.
   */
  onClientDisconnected?: (sessionId: string) => void | Promise<void>;
}

// ============================================================================
// Shutdown Configuration
// ============================================================================

/**
 * Configuration for graceful shutdown behavior.
 */
export interface ShutdownConfig {
  /** Maximum time to wait for graceful shutdown (ms) */
  readonly timeoutMs: number;
  /** Whether to force exit after timeout */
  readonly forceExitOnTimeout: boolean;
  /** Signals to listen for (default: ['SIGINT', 'SIGTERM']) */
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
}

/** Default shutdown timeout in milliseconds (10 seconds). */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Default shutdown configuration values.
 *
 * Configurable only via `ServerOptions.shutdown` (programmatic API).
 * Not exposed as env variable or config file field — shutdown behavior
 * is typically set per-deployment in code, not per-environment.
 */
export const DEFAULT_SHUTDOWN_CONFIG: ShutdownConfig = {
  timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
  forceExitOnTimeout: true,
  signals: ["SIGINT", "SIGTERM"],
};
