/**
 * Server Configuration Types
 *
 * Types for configuring and building MCP servers.
 * Provides a clean, declarative API for server setup.
 *
 * @module server/server-options
 */

import type { HandlersConfig } from "../mcp/types/index.js";
import type { SessionStore } from "./session/index.js";
import type { CreateServerOptions } from "./types.js";

// ============================================================================
// Transport Configuration (canonical location: transport-options.ts)
// ============================================================================

export {
  type TransportMode,
  type TlsConfig,
  type BaseHttpTransportOptions,
  type StdioTransportOptions,
  type HttpTransportOptions,
  type HttpsTransportOptions,
  type TransportOptions,
  isHttpTransport,
} from "./transport-options.js";

// ============================================================================
// Server Capabilities (canonical location: mcp/capabilities/server-capabilities.ts)
// ============================================================================

export { type ServerCapabilities, DEFAULT_CAPABILITIES } from "../mcp/capabilities/server-capabilities.js";

// ============================================================================
// Readiness Configuration
// ============================================================================

/**
 * Readiness endpoint configuration.
 *
 * Provides a generic readiness check hook for the `/ready` endpoint.
 * Consumers implement their own readiness logic (API connectivity,
 * database health, external service checks, etc.).
 *
 * @example
 * ```typescript
 * const server = createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   health: {
 *     readinessCheck: async () => {
 *       const ok = await myApi.ping();
 *       return ok || 'API not reachable';
 *     },
 *     serviceLabel: 'my-api',
 *   },
 * });
 * ```
 */
export interface ReadinessConfig {
  /**
   * Custom readiness check. Called on every `GET /ready` request.
   *
   * - Return `true` (or `undefined`/no check configured) → 200 (ready)
   * - Return `false` → 503 (not ready)
   * - Return a `string` → 503 with the string as reason
   */
  readonly readinessCheck?: () => boolean | string | Promise<boolean | string>;

  /**
   * Maximum time in milliseconds to wait for `readinessCheck` to resolve.
   *
   * If the check does not complete within this window the endpoint returns 503
   * and the pending check is effectively abandoned. This prevents a stalled
   * external dependency (DB, API) from blocking `/ready` indefinitely and
   * thereby delaying Graceful Shutdown (which waits for active HTTP connections).
   *
   * @default 5000
   */
  readonly checkTimeoutMs?: number;

  /**
   * Label for the service in health responses.
   * @default 'service'
   */
  readonly serviceLabel?: string;
}

// ============================================================================
// Session Configuration (Programmatic)
// ============================================================================

/**
 * Session configuration options for the programmatic API.
 *
 * Allows fine-tuning session lifecycle behavior directly from
 * `createServer()` or `McpServerBuilder.withOptions()`. All properties
 * are optional — defaults are resolved from environment variables
 * and config files via the standard config cascade.
 *
 * This is particularly useful for "lightweight stateful" deployments
 * where short session timeouts are preferred over full stateless mode,
 * retaining cross-request features (cancellation, sampling, elicitation)
 * that stateless mode cannot support.
 *
 * @example
 * ```typescript
 * // Lightweight stateful — short-lived sessions with all MCP features
 * createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   session: {
 *     timeoutMs: 60_000,           // 1 minute instead of default 30 min
 *     cleanupIntervalMs: 10_000,   // Check every 10s
 *   },
 * });
 *
 * // Custom session store for horizontal scaling
 * createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   session: { store: new RedisSessionStore() },
 * });
 * ```
 *
 * @see SessionConfig for default values
 */
export interface SessionConfigOptions {
  /**
   * Session timeout in milliseconds.
   *
   * Sessions inactive for longer than this value are cleaned up by the
   * housekeeper. Lower values create "lightweight" sessions that free
   * resources faster.
   *
   * @default 1_800_000 (30 minutes, from MCP_SESSION_TIMEOUT_MS)
   */
  readonly timeoutMs?: number;

  /**
   * Interval between cleanup sweeps in milliseconds.
   *
   * The housekeeper checks for expired/stale sessions at this interval.
   * Set to `0` to disable cleanup (e.g., stdio mode).
   *
   * @default 60_000 (60 seconds, from MCP_SESSION_CLEANUP_INTERVAL_MS)
   */
  readonly cleanupIntervalMs?: number;

  /**
   * Keep-alive heartbeat interval in milliseconds.
   *
   * The housekeeper sends keep-alive pings at this interval to detect
   * dead connections. Set to `0` to disable heartbeats.
   *
   * @default 30_000 (30 seconds, from MCP_SESSION_KEEP_ALIVE_INTERVAL_MS)
   */
  readonly keepAliveIntervalMs?: number;

  /**
   * Maximum missed heartbeats before a session is considered stale.
   *
   * @default 3 (from MCP_SESSION_MAX_MISSED_HEARTBEATS)
   */
  readonly maxMissedHeartbeats?: number;

  /**
   * Maximum concurrent sessions across all transports.
   *
   * @default 200 (from MCP_MAX_SESSIONS)
   */
  readonly maxSessions?: number;

  /**
   * Custom session store implementation.
   *
   * When provided, replaces the built-in in-memory session store.
   * Useful for horizontal scaling with Redis, PostgreSQL, or another
   * shared backend.
   *
   * @default InMemorySessionStore
   */
  readonly store?: SessionStore;
}

// ============================================================================
// Server Options Interface
// ============================================================================

/**
 * Complete server configuration options, as consumed by the builder.
 *
 * Derived from {@link CreateServerOptions} — the single, canonical field list
 * for server configuration — rather than maintained as a parallel interface:
 * identity becomes required (defaults already applied), and the `telemetry`
 * toggle is replaced by the resolved `telemetryEnabled`. New `createServer()`
 * options are inherited here automatically.
 */
export interface ServerOptions extends Omit<CreateServerOptions, "name" | "version" | "telemetry"> {
  /** Server name displayed to MCP clients (default applied by `createServer()`). */
  name: string;

  /** Server version (default applied by `createServer()`). */
  version: string;

  /**
   * Custom protocol handler hooks.
   *
   * Allows customizing behavior when MCP protocol events occur.
   * The framework handles protocol compliance - these are for app logic.
   *
   * Note: Cancellation is handled automatically by the framework.
   */
  handlers?: HandlersConfig | undefined;

  /**
   * Enable OpenTelemetry tracing and metrics — the resolved form of
   * `CreateServerOptions.telemetry` (explicit option → `OTEL_ENABLED` fallback).
   */
  telemetryEnabled?: boolean | undefined;

  /**
   * OpenTelemetry service name.
   *
   * @default Server name
   */
  telemetryServiceName?: string | undefined;
}

// ============================================================================
// Server Builder Result
// ============================================================================

/**
 * Result from server builder/factory.
 */
export interface ServerInstance {
  /** Start the server */
  start(): Promise<void>;

  /** Stop the server gracefully */
  stop(): Promise<void>;

  /**
   * Initialize OpenTelemetry before starting the server.
   *
   * OTEL auto-instrumentation must be initialized before any HTTP/Express
   * modules are loaded to properly instrument them. Call this method
   * as early as possible in your application bootstrap.
   *
   * If not called explicitly, `start()` will initialize telemetry
   * automatically as a fallback (but auto-instrumentation may miss
   * modules already loaded).
   *
   * No-op if telemetry is not enabled in server options.
   *
   * @example
   * ```typescript
   * const server = builder.build();
   * await server.initTelemetry(); // Before any other imports
   * await server.start();
   * ```
   */
  initTelemetry(): Promise<void>;

  /**
   * Notify all connected MCP clients that the tool list has changed.
   *
   * Call this when tool availability changes (e.g., connection state).
   * The framework will send `notifications/tools/list_changed` to all
   * connected clients per MCP specification.
   *
   * @example
   * ```typescript
   * // When API connection established
   * apiClient.on('connected', () => server.notifyToolListChanged());
   *
   * // When API connection lost
   * apiClient.on('disconnected', () => server.notifyToolListChanged());
   * ```
   */
  notifyToolListChanged(): void;

  /**
   * Notify all connected MCP clients that the resource list has changed.
   *
   * Call this when resource availability changes dynamically.
   * The framework will send `notifications/resources/list_changed` to all
   * connected clients per MCP specification.
   */
  notifyResourceListChanged(): void;

  /**
   * Notify all connected MCP clients that the prompt list has changed.
   *
   * Call this when prompt availability changes dynamically.
   * The framework will send `notifications/prompts/list_changed` to all
   * connected clients per MCP specification.
   */
  notifyPromptListChanged(): void;

  /**
   * Notify subscribed MCP clients that a specific resource has been updated.
   *
   * Only clients that previously sent `resources/subscribe` for the given URI
   * receive the `notifications/resources/updated` notification.
   *
   * Requires `capabilities: { resources: { subscribe: true } }` to be set.
   *
   * @param uri - The resource URI that has changed
   *
   * @example
   * ```typescript
   * // When a monitored resource changes
   * server.notifyResourceUpdated('config://app/settings');
   * ```
   */
  notifyResourceUpdated(uri: string): void;

  /** Server name */
  readonly name: string;

  /** Server version */
  readonly version: string;

  /** Whether the server is running */
  readonly isRunning: boolean;
}
