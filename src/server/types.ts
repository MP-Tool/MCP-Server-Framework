/**
 * Create Server Types
 *
 * Types for the createServer() high-level API.
 *
 * @module server/types
 */

import type { TransportOptions, ServerCapabilities, HealthConfig, SessionConfigOptions } from "./server-options.js";
import type { ServerLifecycleHooks, ShutdownConfig } from "./lifecycle.js";
import type { AuthOptions } from "./auth/types.js";

// ============================================================================
// Create Server Options
// ============================================================================

/**
 * Options for createServer() - simplified high-level API.
 *
 * This interface provides sensible defaults while allowing customization.
 * All fields are optional except for name and version (which have defaults).
 *
 * @example
 * ```typescript
 * // Minimal - transport resolved from config cascade
 * const server = createServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 * });
 * ```
 */
export interface CreateServerOptions {
  // ─────────────────────────────────────────────────────────────────────────
  // Server Identity (Optional with defaults)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Server name displayed to MCP clients.
   *
   * @default 'mcp-server'
   */
  name?: string;

  /**
   * Server version.
   *
   * @default '1.0.0'
   */
  version?: string;

  // ─────────────────────────────────────────────────────────────────────────
  // Transport (Optional — resolved from config cascade if omitted)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transport configuration.
   *
   * When omitted, transport mode is resolved from the config cascade:
   * schema defaults → `.env` file → config file → environment variables.
   *
   * Host and port are always resolved from the config cascade
   * (`MCP_BIND_HOST`, `MCP_PORT`) regardless of whether transport is set.
   *
   * @default Resolved from `MCP_TRANSPORT` (default: `'stdio'`)
   * @see TransportOptions for details
   */
  transport?: TransportOptions;

  // ─────────────────────────────────────────────────────────────────────────
  // Capabilities (Optional - sensible defaults)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Server capabilities to advertise.
   *
   * @default { tools: { listChanged: true }, logging: true }
   */
  capabilities?: ServerCapabilities;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Lifecycle hooks for startup/shutdown.
   */
  lifecycle?: ServerLifecycleHooks;

  /**
   * Shutdown configuration.
   */
  shutdown?: Partial<ShutdownConfig>;

  // ─────────────────────────────────────────────────────────────────────────
  // Health Endpoint (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Health endpoint configuration for API connectivity monitoring.
   *
   * Wires a {@link ConnectionStateManager} to the `/ready` endpoint so
   * readiness probes reflect the actual API connection state.
   *
   * @see HealthConfig
   */
  health?: HealthConfig;

  // ─────────────────────────────────────────────────────────────────────────
  // Session Configuration (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Session management configuration.
   *
   * Fine-tune session lifecycle (timeouts, cleanup, capacity).
   * Only effective for HTTP-based transports.
   *
   * @see SessionConfigOptions
   */
  session?: SessionConfigOptions;

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Authentication configuration.
   *
   * Enables OAuth 2.1 or custom token verification on the server.
   * Only effective for HTTP-based transports.
   *
   * @see AuthOptions
   */
  auth?: AuthOptions;

  // ─────────────────────────────────────────────────────────────────────────
  // Telemetry (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Enable OpenTelemetry integration.
   *
   * When not set, falls back to `OTEL_ENABLED` env var or config file.
   * Set explicitly to `true` or `false` to override the config.
   *
   * @default undefined (falls back to OTEL_ENABLED)
   */
  telemetry?: boolean;

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
   *
   * **Important**: Custom DiagLoggers must NOT write to stdout (reserved
   * for MCP protocol data in stdio transport mode).
   *
   * @see ServerOptions.onBeforeTelemetryInit for the full documentation
   */
  onBeforeTelemetryInit?: () => void;
}

/**
 * Result returned from createServer().
 */
export interface CreateServerResult {
  /**
   * Start the server.
   *
   * @returns Promise that resolves when server is fully started
   */
  start: () => Promise<void>;

  /**
   * Stop the server gracefully.
   *
   * @returns Promise that resolves when server is stopped
   */
  stop: () => Promise<void>;

  /**
   * Initialize OpenTelemetry before starting the server.
   *
   * Call as early as possible so OTEL auto-instrumentation can
   * hook into HTTP/Express modules before they are loaded.
   * No-op if telemetry is disabled. Falls back automatically
   * in `start()` if not called explicitly.
   */
  initTelemetry: () => Promise<void>;

  /**
   * Notify all connected MCP clients that the tool list has changed.
   *
   * Call this when external state changes affect tool availability
   * (e.g., API connection state, feature flags).
   */
  notifyToolListChanged: () => void;

  /**
   * Notify all connected MCP clients that the resource list has changed.
   */
  notifyResourceListChanged: () => void;

  /**
   * Notify all connected MCP clients that the prompt list has changed.
   */
  notifyPromptListChanged: () => void;

  /**
   * Notify subscribed MCP clients that a specific resource has been updated.
   *
   * Only clients that previously sent `resources/subscribe` for the given URI
   * receive the `notifications/resources/updated` notification.
   *
   * Requires `capabilities: { resources: { subscribe: true } }` to be set.
   *
   * @param uri - The resource URI that has changed
   */
  notifyResourceUpdated: (uri: string) => void;
}
