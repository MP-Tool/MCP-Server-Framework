/**
 * Create Server Types
 *
 * Types for the createServer() high-level API.
 *
 * @module server/types
 */

import type { TransportOptions, ServerCapabilities, ReadinessConfig, SessionConfigOptions } from "./server-options.js";
import type { ServerLifecycleHooks, ShutdownConfig } from "./lifecycle.js";
import type { AuthOptions } from "./auth/types.js";
import type { ScrubToolResultsConfig } from "../mcp/capabilities/registry/index.js";
import type { ToolDefinition, AuditToolIoLevel } from "../mcp/types/index.js";
import type { Application } from "express";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";

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
  name?: string | undefined;

  /**
   * Server version.
   *
   * @default '1.0.0'
   */
  version?: string | undefined;

  /**
   * Human-friendly display name shown by MCP clients, distinct from the
   * machine-readable `name`.
   *
   * @example 'My MCP Server'
   */
  title?: string | undefined;

  /**
   * Icons representing this server, shown by MCP clients that support
   * branding. Use `iconFromFile()` to build an entry from a local image file.
   */
  icons?: Icon[] | undefined;

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
  transport?: TransportOptions | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Capabilities (Optional - sensible defaults)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Server capabilities to advertise.
   *
   * @default { tools: { listChanged: true }, logging: true }
   */
  capabilities?: ServerCapabilities | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle (Optional)
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
   * Readiness endpoint configuration.
   *
   * Provides a generic readiness check hook for the `/ready` endpoint.
   * Consumers supply their own check logic.
   *
   * @see ReadinessConfig
   */
  health?: ReadinessConfig | undefined;

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
  session?: SessionConfigOptions | undefined;

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
  auth?: AuthOptions | undefined;

  /**
   * Optional hook to customize the Express app for HTTP/HTTPS transports.
   *
   * Useful for registering additional callback endpoints on the MCP host
   * (for example `/auth/google/callback`). Ignored in stdio mode.
   */
  configureHttpApp?: ((app: Application) => void) | undefined;

  // ─────────────────────────────────────────────────────────────────────────
  // Security (Optional)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Central secret redaction for tool results.
   *
   * Every tool (and task-tool) result is scrubbed for secrets at the single
   * boundary between the tool handler and the SDK, before it reaches the
   * client transcript and the model provider. Fail-closed: if scrubbing
   * itself fails, the result is withheld and replaced by a generic error.
   *
   * - `true` / omitted → scrub with the base heuristics (**default ON**)
   * - `false` → disable scrubbing
   * - `{ additionalKeys, allowKeys }` → extend the sensitive-key set /
   *   exempt exact key names (e.g. `public_key`) from key-based redaction
   *
   * Individual tools whose purpose is returning a secret can opt out via
   * `ToolDefinition.scrubResult: false`.
   *
   * @default true
   */
  scrubToolResults?: ScrubToolResultsConfig | undefined;

  /**
   * How much request/response detail the per-tool-call audit entry records
   * (always secret-scrubbed). `off` | `summary` (default) | `full`.
   *
   * Overrides the `LOG_AUDIT_TOOL_IO` env var when set. See {@link AuditToolIoLevel}.
   */
  auditToolIo?: AuditToolIoLevel | undefined;

  /**
   * Scopes granted to **anonymous** (unauthenticated) requests.
   *
   * When set, a request that carries no `authInfo` is treated as holding exactly
   * these scopes: a tool/resource/prompt is listed (`tools/list` etc.) and callable
   * only when its `requiredScopes ⊆ anonymousScopes`. Everything above the granted
   * set is hidden from the listing and rejected on call — the existing scope RBAC
   * (scope enforcement + the scope-filtered list handlers) applies to anonymous
   * traffic instead of being skipped.
   *
   * This never fabricates an identity: `ToolContext.auth` stays `undefined` for
   * anonymous requests, so a consumer's own auth-derived logic is unaffected.
   * Authenticated requests are unaffected (their real token scopes always win).
   *
   * Intended for deployments that run **without per-user auth on a network
   * transport** — grant `[<read-scope>]` so an open server is read-only. Leave
   * `undefined` (the default) to preserve unrestricted anonymous access, e.g. for
   * stdio.
   */
  anonymousScopes?: readonly string[] | undefined;

  /**
   * Predicate deciding which tools are registered. A tool is kept only when this
   * returns `true`; tools it rejects are never bound to any session — absent from
   * `tools/list` and not callable, for every request.
   *
   * Applied once at build time to the collected tools. Intended as an operator
   * knob to prune the tool surface (e.g. by `_meta.category` or name) to reduce a
   * client's context/token load. It is **purely subtractive**: it can only remove
   * tools, never expose more, so it composes safely with `anonymousScopes` and any
   * per-request scope/permission gating (those still apply to whatever remains).
   *
   * The framework does not interpret tool metadata — supply the semantics here.
   * `undefined` (the default) registers all tools.
   */
  filterTools?: ((tool: ToolDefinition) => boolean) | undefined;

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
  telemetry?: boolean | undefined;

  /**
   * Called before the OpenTelemetry SDK is initialized.
   *
   * Power users can use this callback to configure low-level OTEL APIs
   * before the framework creates the NodeSDK instance. Common use cases:
   *
   * - Set a custom `DiagLogger` via `diag.setLogger()` for SDK-level
   *   diagnostics (by default they go to the framework logger at `OTEL_LOG_LEVEL`)
   * - Register custom instrumentation
   * - Configure global propagators or samplers
   *
   * The callback runs after framework config resolution and the default
   * `DiagLogger` setup, but before SDK construction.
   *
   * **Important**: Custom DiagLoggers must NOT write to stdout (reserved
   * for MCP protocol data in stdio transport mode).
   *
   * @see ServerOptions.onBeforeTelemetryInit for the full documentation
   */
  onBeforeTelemetryInit?: (() => void) | undefined;
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
