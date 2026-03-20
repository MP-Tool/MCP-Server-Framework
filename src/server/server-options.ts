/**
 * Server Configuration Types
 *
 * Types for configuring and building MCP servers.
 * Provides a clean, declarative API for server setup.
 *
 * @module server/server-options
 */

import type { ServerLifecycleHooks, ShutdownConfig } from "./lifecycle.js";
import type { HandlersConfig } from "../mcp/types/index.js";
import type { ConnectionStateManager } from "../connection/index.js";
import type { ServiceClient } from "../connection/types.js";
import type { SessionStore } from "./session/index.js";
import type { ServerCapabilities } from "../mcp/capabilities/server-capabilities.js";
import type { TransportOptions } from "./transport-options.js";
import type { AuthOptions } from "./auth/types.js";

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
// Health Configuration
// ============================================================================

/**
 * Health endpoint configuration for API connectivity monitoring.
 *
 * Allows consumers to wire their {@link ConnectionStateManager} to the
 * `/ready` endpoint so readiness probes reflect the actual API connection state.
 *
 * Without this configuration, the `/ready` endpoint reports
 * `api: { configured: false, state: 'unknown', connected: false }`.
 *
 * @example
 * ```typescript
 * const server = createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http' },
 *   health: {
 *     connectionManager: myConnectionManager,
 *     isApiConfigured: () => !!process.env.MY_API_URL,
 *     apiLabel: 'my-api',
 *   },
 * });
 * ```
 */
export interface HealthConfig<TService extends ServiceClient = ServiceClient> {
  /**
   * Connection state manager for API health checks.
   * If not provided, API connectivity checks are skipped.
   */
  readonly connectionManager?: ConnectionStateManager<TService>;

  /**
   * Function to check if the API is configured.
   * If not provided, defaults to checking for `API_URL` env var.
   */
  readonly isApiConfigured?: () => boolean;

  /**
   * Label for the API in health responses (e.g., 'my-api', 'docker').
   * @default 'api'
   */
  readonly apiLabel?: string;
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
 * Complete server configuration options.
 *
 * This interface provides a declarative way to configure an MCP server.
 * All options have sensible defaults.
 *
 * @example
 * ```typescript
 * const options: ServerOptions = {
 *   name: 'my-mcp-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http', port: 8080 },
 *   capabilities: { tools: true, resources: true },
 *   lifecycle: {
 *     onStarted: () => console.log('Server started!'),
 *   },
 * };
 * ```
 */
export interface ServerOptions {
  // ─────────────────────────────────────────────────────────────────────────
  // Server Identity
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Server name displayed to MCP clients.
   *
   * @example 'my-mcp-server', 'api-mcp-server'
   */
  name: string;

  /**
   * Server version (typically from package.json).
   *
   * @example '1.0.0'
   */
  version: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Transport Configuration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transport configuration (required).
   *
   * Explicitly specify how the server communicates with clients.
   * Use `{ mode: 'stdio' }` for CLI usage or `{ mode: 'http' }` for network usage.
   */
  transport: TransportOptions;

  // ─────────────────────────────────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Server capabilities to advertise.
   *
   * @default { tools: { listChanged: true }, logging: true }
   */
  capabilities?: ServerCapabilities | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Protocol Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Custom protocol handler hooks.
   *
   * Allows customizing behavior when MCP protocol events occur.
   * The framework handles protocol compliance - these are for app logic.
   *
   * Note: Cancellation is handled automatically by the framework.
   *
   * @example
   * ```typescript
   * handlers: {
   *   onPing: () => metrics.increment('mcp.ping'),
   * }
   * ```
   */
  handlers?: HandlersConfig | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lifecycle hooks for startup/shutdown.
   */
  lifecycle?: ServerLifecycleHooks | undefined;

  /**
   * Shutdown configuration.
   */
  shutdown?: Partial<ShutdownConfig> | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Health Endpoint (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Health endpoint configuration for API connectivity monitoring.
   *
   * Wires a {@link ConnectionStateManager} to the `/ready` endpoint so
   * readiness probes reflect the actual API connection state.
   */
  health?: HealthConfig | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Session Configuration (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Session management configuration.
   *
   * Fine-tune session lifecycle behavior (timeouts, cleanup intervals,
   * capacity). Only relevant for HTTP-based transports — stdio always
   * uses a single session with no background tasks.
   *
   * All values are optional and fall back to environment variables / config
   * file defaults from the standard config cascade.
   *
   * @see SessionConfigOptions for available options and defaults
   */
  session?: SessionConfigOptions | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Authentication configuration.
   *
   * Enables OAuth 2.1 or custom token verification on the server.
   * When configured, the `/mcp` endpoint requires Bearer authentication.
   * Health and metrics endpoints remain unauthenticated for probes.
   *
   * Only relevant for HTTP-based transports — stdio mode does not
   * support authentication (a warning is logged if configured).
   *
   * @example OAuth provider
   * ```typescript
   * createServer({
   *   name: 'my-server',
   *   version: '1.0.0',
   *   transport: { mode: 'http' },
   *   auth: {
   *     provider: myOAuthProvider,
   *     issuerUrl: new URL('https://auth.example.com'),
   *     requiredScopes: ['mcp:read'],
   *   },
   * });
   * ```
   *
   * @example Custom token verifier
   * ```typescript
   * createServer({
   *   name: 'my-server',
   *   version: '1.0.0',
   *   transport: { mode: 'http' },
   *   auth: {
   *     provider: { verifyAccessToken: async (token) => ({ ... }) },
   *   },
   * });
   * ```
   *
   * @see AuthOptions for all configuration options
   */
  auth?: AuthOptions | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Telemetry (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enable OpenTelemetry tracing and metrics.
   *
   * When set via `createServer()`, this is resolved from:
   * 1. Explicit `telemetry` option (highest priority)
   * 2. `OTEL_ENABLED` env var or config file (fallback)
   *
   * @default undefined (resolved from config)
   */
  telemetryEnabled?: boolean | undefined;

  /**
   * OpenTelemetry service name.
   *
   * @default Server name
   */
  telemetryServiceName?: string | undefined;

  /**
   * Called before the OpenTelemetry SDK is initialized.
   *
   * Power users can use this callback to configure low-level OTEL APIs
   * before the framework creates the NodeSDK instance. Common use cases:
   *
   * - Set a custom `DiagLogger` via `diag.setLogger()` for SDK-level
   *   diagnostics (by default no DiagLogger is set — output is suppressed)
   * - Register custom instrumentation
   * - Configure global propagators or samplers
   *
   * The callback runs after framework config resolution but before
   * `OTEL_LOG_LEVEL` is consumed from `process.env` and SDK construction.
   * If you set a DiagLogger here, the framework will not override it.
   *
   * **Important**: Custom DiagLoggers must NOT write to stdout (reserved
   * for MCP protocol data in stdio transport mode).
   *
   * @example
   * ```typescript
   * import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
   *
   * const server = createServer({
   *   name: 'my-server',
   *   version: '1.0.0',
   *   onBeforeTelemetryInit: () => {
   *     diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
   *   },
   * });
   * ```
   */
  onBeforeTelemetryInit?: (() => void) | undefined;
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
