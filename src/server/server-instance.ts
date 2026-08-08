/**
 * MCP Server Instance
 *
 * The central framework object. Runtime implementation of the ServerInstance
 * interface. Manages the MCP server lifecycle including transport selection,
 * session management, signal handling, and graceful shutdown.
 *
 * Each connected client gets its own McpSession (1:1 per MCP SDK spec).
 * Session creation is delegated to McpSessionFactory (SRP).
 * Cancellation and progress are handled natively by the SDK.
 *
 * This class is created by McpServerBuilder and should not be
 * instantiated directly by application code.
 *
 * @module server/server-instance
 */

import type { ServerOptions, ServerInstance, TransportMode } from "./server-options.js";
import { isHttpTransport } from "./server-options.js";
import { mapServerOptionsToOverrides } from "./option-overrides.js";
import type { ServerState, ShutdownConfig } from "./lifecycle.js";

import { startStdioTransport } from "./transport/stdio-transport.js";
import type { TransportHandle } from "./transport/types.js";
import { SessionManagerImpl } from "./session/index.js";
import type { SessionManager } from "./session/index.js";
import { Logger, logger as frameworkLogger } from "../logger/index.js";
import { configureLoggerFromEnv } from "./logger-config.js";
import { initializeTelemetry, shutdownTelemetry } from "../telemetry/index.js";
import { DEFAULT_SHUTDOWN_CONFIG } from "./lifecycle.js";
import type { McpSessionFactory } from "./session/session-factory.js";
import { getFrameworkConfig } from "../config/index.js";
import { applyConfigOverrides, setConfigLogger } from "../config/config-cache.js";
import { flushStartupWarnings } from "../config/startup-warnings.js";
import { isFullOAuthProvider } from "./auth/types.js";
import { getDynamicResourceRegistry } from "../mcp/capabilities/resources/index.js";
import { initializeAuditLog, resolveAuditFilePath } from "../logger/audit/index.js";

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "server-runtime";

const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

const RuntimeLogMessages = {
  SERVER_STARTING: "Server starting...",
  SERVER_STARTED: "Server started: %s v%s (%s mode)",
  SERVER_START_FAILED: "Server start failed: %s",
  SERVER_STOPPING: "Server stopping...",
  SERVER_STOPPED: "Server stopped",
  SERVER_ALREADY_RUNNING: "Server is already running.",
  SHUTDOWN_SIGNAL: "Received shutdown signal: %s",
  SHUTDOWN_FORCED: "Forcing server shutdown after timeout",
  SHUTDOWN_ALREADY: "Shutdown already in progress",
  // State transitions
  STATE_TRANSITION: "Server state: %s → %s",
  // Telemetry
  TELEMETRY_INIT: "OpenTelemetry initialized",
  TELEMETRY_SKIPPED: "OpenTelemetry disabled — skipping initialization",
  // Lifecycle hooks
  LIFECYCLE_HOOK_ERROR: "Lifecycle hook %s failed: %s",
  // Transport
  TRANSPORT_STARTING: "Starting %s transport...",
  STATELESS_MODE:
    "Stateless mode active — sessions are per-request. Per-request features (progress, logging, abort) work normally. Cross-request features (cancellation, sampling, elicitation, roots, GET SSE) are unavailable by design.",
  STATELESS_EVENT_STORE_IGNORED:
    "eventStore is set but has no effect in stateless mode — events are not persisted without sessions.",
  STATELESS_SSE_IGNORED:
    "legacySseEnabled is set but has no effect in stateless mode — SSE requires persistent sessions.",
  // Partial cleanup
  PARTIAL_CLEANUP: "Cleaning up partially initialized resources after start failure",
  // Auth
  AUTH_OAUTH_ENABLED: "OAuth authentication enabled (issuer: %s)",
  AUTH_BEARER_ENABLED: "Bearer token authentication enabled (custom verifier)",
  AUTH_STDIO_WARNING: "Auth configuration ignored in stdio mode — stdio does not support authentication",
  AUTH_NO_TRUST_PROXY:
    "Auth is enabled without trust proxy — client IP detection may be inaccurate behind a reverse proxy",
  AUTH_PROVIDER_DISPOSED: "Auth provider disposed",
  EVENT_STORE_DISPOSED: "Event store disposed",
  // Shutdown cleanup
  SHUTDOWN_STEP_FAILED: "Shutdown step %s failed: %s",
  // Process error handlers
  UNHANDLED_REJECTION: "Unhandled promise rejection — initiating graceful shutdown: %s",
  UNCAUGHT_EXCEPTION: "Uncaught exception — initiating graceful shutdown: %s",
  SHUTDOWN_FAILED: "Graceful shutdown failed: %s",
} as const;

const logger = frameworkLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Server Instance Implementation
// ============================================================================

/**
 * The central MCP server framework object.
 *
 * Manages the MCP server lifecycle including:
 * - Multi-session support (one McpSession per client in HTTP mode)
 * - Transport selection (stdio/http/https)
 * - Signal handling with graceful shutdown
 *
 * Session creation is delegated to {@link McpSessionFactory}.
 *
 * @internal Created by McpServerBuilder — do not instantiate directly.
 */
export class McpServerInstance implements ServerInstance {
  private serverState: ServerState = "created";

  /** Whether telemetry has been initialized */
  private telemetryInitialized = false;

  /** Resolved transport mode, cached at construction time */
  private readonly transportMode: TransportMode;

  /** Unified session manager — single source of truth for all sessions */
  private sessionManager?: SessionManager | undefined;

  /** Transport handle for shutdown and info queries */
  private transportHandle?: TransportHandle | undefined;

  /** Stored signal handler references for cleanup on stop/restart */
  private signalHandlers: Array<{
    signal: NodeJS.Signals;
    handler: () => void;
  }> = [];

  /** Stored process error handler references for cleanup on stop/restart */
  private processErrorHandlers: Array<{
    event: string;
    handler: (...args: unknown[]) => void;
  }> = [];

  /** Guard against concurrent shutdown from multiple error sources */
  private shutdownInProgress = false;

  constructor(
    private readonly options: ServerOptions,
    private readonly sessionFactory: McpSessionFactory,
  ) {
    this.transportMode = options.transport?.mode ?? "stdio";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ServerInstance Interface
  // ─────────────────────────────────────────────────────────────────────────

  get name(): string {
    return this.options.name;
  }

  get version(): string {
    return this.options.version;
  }

  get isRunning(): boolean {
    return this.serverState === "running";
  }

  /**
   * Notify all connected MCP clients that the tool list has changed.
   *
   * Call this when external connection state changes affect tool availability.
   * Delegates to the unified SessionManager which handles all transport types.
   */
  notifyToolListChanged(): void {
    this.sessionManager?.broadcastToolListChanged();
  }

  /**
   * Notify all connected MCP clients that the resource list has changed.
   */
  notifyResourceListChanged(): void {
    this.sessionManager?.broadcastResourceListChanged();
  }

  /**
   * Notify all connected MCP clients that the prompt list has changed.
   */
  notifyPromptListChanged(): void {
    this.sessionManager?.broadcastPromptListChanged();
  }

  /**
   * Notify subscribed MCP clients that a specific resource has been updated.
   * Only sessions that subscribed to the given URI receive the notification.
   */
  notifyResourceUpdated(uri: string): void {
    this.sessionManager?.broadcastResourceUpdated(uri);
  }

  /**
   * Initialize OpenTelemetry before starting the server.
   *
   * OTEL auto-instrumentation must be initialized before any HTTP/Express
   * modules are loaded to properly instrument them. Call this as early
   * as possible. No-op if telemetry is disabled or already initialized.
   */
  async initTelemetry(): Promise<void> {
    if (this.telemetryInitialized) {
      return;
    }
    if (!this.options.telemetryEnabled) {
      logger.debug(RuntimeLogMessages.TELEMETRY_SKIPPED);
      return;
    }
    await initializeTelemetry(this.options.onBeforeTelemetryInit);
    this.telemetryInitialized = true;
  }

  async start(): Promise<void> {
    if (this.serverState === "running" || this.serverState === "starting") {
      logger.warn(RuntimeLogMessages.SERVER_ALREADY_RUNNING);
      return;
    }

    this.transitionState("starting");

    // Register signal handlers FIRST so that SIGINT/SIGTERM during any
    // async startup step (telemetry init, transport bind) triggers
    // graceful shutdown instead of a hard process exit.
    this.setupSignalHandlers();

    try {
      // Bridge programmatic options → framework config cache.
      // Must happen BEFORE logger config so that MCP_TRANSPORT is correct
      // when the logger decides stdout vs stderr routing (stdio safety).
      this.applyProgrammaticOverrides();

      // Bridge config file values → logger (must run after config resolution)
      this.applyLoggerConfig();

      // Eagerly open the audit-log stream — same reasoning as the file logger above:
      // create it now (path visible in startup logs) instead of only after the first
      // audited event, which reads as "audit logging isn't working" during a smoke test.
      // The audit sink reads no config itself (logger block stays config-free) — resolve
      // its destination and the shared LOG_* rotation limits here instead.
      const auditConfig = getFrameworkConfig();
      initializeAuditLog({
        filePath: resolveAuditFilePath(auditConfig.LOG_DIR, auditConfig.LOG_AUDIT_FILE),
        maxSizeBytes: auditConfig.LOG_MAX_FILE_SIZE,
        maxFiles: auditConfig.LOG_MAX_FILES,
      });

      // Inject logger into config module (breaks config→logger dependency)
      setConfigLogger(frameworkLogger.child({ component: "config" }));

      // Replay startup warnings through the now-configured logger
      flushStartupWarnings((msg) => logger.warn(msg));

      logger.info(RuntimeLogMessages.SERVER_STARTING);

      // Initialize telemetry BEFORE lifecycle hooks so that consumer
      // API calls in onStarting() are already instrumented (DD-018).
      await this.initTelemetry();

      await this.invokeLifecycleHook("onStarting", () => this.options.lifecycle?.onStarting?.());

      const sessionFactory = () => this.sessionFactory.create();
      this.sessionManager = this.createSessionManager();
      this.transportHandle = await this.startTransport(sessionFactory, this.sessionManager);

      // Log stateless mode warning after transport is started. Resolved from config for the
      // same reason as the handler selection above: reading `transport.stateless` alone would
      // stay silent for an operator who enabled stateless via MCP_STATELESS or the config file.
      if (this.options.transport && isHttpTransport(this.options.transport) && getFrameworkConfig().MCP_STATELESS) {
        logger.warn(RuntimeLogMessages.STATELESS_MODE);

        // Warn about ineffective config combinations
        if (this.options.transport.eventStore) {
          logger.warn(RuntimeLogMessages.STATELESS_EVENT_STORE_IGNORED);
        }
        if (this.options.transport.legacySseEnabled) {
          logger.warn(RuntimeLogMessages.STATELESS_SSE_IGNORED);
        }
      }

      // Log auth configuration
      this.logAuthConfiguration();

      this.transitionState("running");

      await this.invokeLifecycleHook("onStarted", () => this.options.lifecycle?.onStarted?.());

      logger.info(RuntimeLogMessages.SERVER_STARTED, this.options.name, this.options.version, this.transportMode);
    } catch (error) {
      this.transitionState("error");
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(RuntimeLogMessages.SERVER_START_FAILED, err.message);

      // Remove signal handlers so they don't trigger on a failed server
      this.removeSignalHandlers();

      // Cleanup partially initialized resources — each step individually
      // guarded (error isolation), mirroring the pattern used in stop().
      if (this.sessionManager || this.transportHandle || this.telemetryInitialized) {
        logger.debug(RuntimeLogMessages.PARTIAL_CLEANUP);
      }
      if (this.sessionManager) {
        this.sessionManager.dispose();
        this.sessionManager = undefined;
      }
      if (this.transportHandle) {
        await this.transportHandle.shutdown();
        this.transportHandle = undefined;
      }
      if (this.telemetryInitialized) {
        await shutdownTelemetry();
        this.telemetryInitialized = false;
      }

      await this.invokeLifecycleHook("onError", () => this.options.lifecycle?.onError?.(err));
      throw err;
    }
  }

  /**
   * Gracefully stop the server.
   *
   * Performs cleanup in order: sessions → transport → auth → logger → telemetry.
   * Each step is individually guarded (error isolation) so that a failure
   * in one step does not prevent the remaining steps from running.
   * Idempotent — calling `stop()` on an already stopped server is a no-op.
   */
  async stop(): Promise<void> {
    if (this.serverState === "stopping" || this.serverState === "stopped") {
      logger.debug(RuntimeLogMessages.SHUTDOWN_ALREADY);
      return;
    }

    this.transitionState("stopping");
    logger.info(RuntimeLogMessages.SERVER_STOPPING);

    this.removeSignalHandlers();

    await this.invokeLifecycleHook("onStopping", () => this.options.lifecycle?.onStopping?.());

    // Each cleanup step is individually guarded so that a failure in one
    // step does not prevent the remaining steps from running (error isolation).
    const runShutdownStep = async (step: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        logger.warn(
          RuntimeLogMessages.SHUTDOWN_STEP_FAILED,
          step,
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    await runShutdownStep("sessions", async () => {
      if (this.sessionManager) {
        await this.sessionManager.closeAll();
        this.sessionManager.dispose();
      }
    });
    await runShutdownStep("transport", async () => {
      await this.transportHandle?.shutdown();
    });
    await runShutdownStep("auth-provider", () => this.disposeAuthProvider());
    await runShutdownStep("event-store", () => this.disposeEventStore());
    await runShutdownStep("telemetry", async () => {
      if (this.options.telemetryEnabled) {
        await shutdownTelemetry();
      }
    });

    this.transitionState("stopped");

    await this.invokeLifecycleHook("onStopped", () => this.options.lifecycle?.onStopped?.());

    // Log the final "stopped" message before closing streams so it is flushed
    // to file-based log targets (N1: previously closeStreams ran first).
    logger.info(RuntimeLogMessages.SERVER_STOPPED);

    try {
      await Logger.closeStreams();
    } catch (error) {
      // Streams already closed or failed — nothing more we can log reliably.
      console.error("[server] Logger.closeStreams() failed:", error instanceof Error ? error.message : String(error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the unified SessionManager.
   *
   * For stdio mode: single session, no cleanup/keepalive cycles.
   * For HTTP modes: default config from environment/constants.
   */
  private createSessionManager(): SessionManager {
    const lifecycle = this.options.lifecycle;
    const userOnDisconnected = lifecycle?.onClientDisconnected;

    // Always wrap onClientDisconnected so dynamic per-session resources are
    // released regardless of whether the consumer provided a hook.
    const wrappedOnClientDisconnected = async (sessionId: string): Promise<void> => {
      try {
        getDynamicResourceRegistry().unregisterBySession(sessionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Dynamic resource cleanup failed for session %s: %s", sessionId, msg);
      }
      if (userOnDisconnected) {
        await userOnDisconnected(sessionId);
      }
    };

    const sessionLifecycle = {
      ...(lifecycle?.onClientConnected && { onClientConnected: lifecycle.onClientConnected }),
      onClientDisconnected: wrappedOnClientDisconnected,
    };

    // Stdio: single session, no background tasks.
    // HTTP: merge programmatic session options with lifecycle hooks.
    if (this.transportMode === "stdio") {
      return new SessionManagerImpl({
        cleanupIntervalMs: 0,
        keepAliveIntervalMs: 0,
        maxSessions: 1,
        lifecycle: sessionLifecycle,
      });
    }

    const sessionConfig = this.options.session;
    return new SessionManagerImpl({
      ...sessionConfig,
      lifecycle: sessionLifecycle,
    });
  }

  /**
   * Bridges config file / env values into the logger configuration.
   *
   * The logger has its own `globalLoggerConfig` (default: info) which is
   * intentionally decoupled from the framework config (DD-006). This method
   * acts as the explicit bridge — reading resolved config values and
   * forwarding them to `configureLogger()`.
   */
  private applyLoggerConfig(): void {
    configureLoggerFromEnv({ name: this.options.name, version: this.options.version });
  }

  /**
   * Bridges programmatic `createServer()` options into the framework
   * config cache so that all downstream modules (telemetry, SSE router,
   * rate limiter, health endpoint, etc.) see consistent configuration.
   *
   * Bridges:
   * - `options.version` → `config.VERSION` (fixes `service_version="unknown"`)
   * - `options.name` → `config.OTEL_SERVICE_NAME` (default, unless env/config file overrides)
   * - Transport HTTP options → corresponding config keys
   *
   * Environment variables remain the default — programmatic options override them.
   */
  private applyProgrammaticOverrides(): void {
    const overrides = mapServerOptionsToOverrides(this.options, getFrameworkConfig());
    if (Object.keys(overrides).length > 0) {
      applyConfigOverrides(overrides);
    }
  }

  /**
   * Start the appropriate transport for the configured mode.
   *
   * For HTTP/HTTPS: dynamically loads Express modules (after OTEL init),
   * creates Express app with full middleware stack, then starts the HTTP server.
   * For stdio: creates a single session connected to stdin/stdout.
   *
   * @lazy-transport Express/HTTP modules are loaded via dynamic `import()` so
   * that OTEL instrumentation initializes before Express is imported.
   * See DD-006 for the established lazy-import pattern and DD-018 for
   * the Express lazy-loading rationale.
   */
  private async startTransport(
    sessionFactory: () => ReturnType<McpSessionFactory["create"]>,
    sessionManager: SessionManager,
  ): Promise<TransportHandle> {
    const transport = this.options.transport ?? ({ mode: "stdio" } as const);
    if (isHttpTransport(transport)) {
      // @lazy-transport — Express loaded after OTEL init (see method JSDoc)
      const [{ createExpressApp }, { startHttpTransport }, { resolveTrustProxy }] = await Promise.all([
        import("./http/index.js"),
        import("./http/http-transport.js"),
        import("./middleware/trust-proxy.js"),
      ]);

      // Resolve trust proxy from config (merges env, config file, programmatic)
      const resolvedConfig = getFrameworkConfig();
      const trustProxy = await resolveTrustProxy(resolvedConfig.MCP_TRUST_PROXY);

      const resolvedJsonResponse = resolvedConfig.MCP_JSON_RESPONSE;
      // Resolved, not read straight off `transport` — `applyConfigOverrides()` already folded
      // the programmatic value into the config chain, so reading it back here is what lets
      // `MCP_STATELESS` / `[transport].stateless` take effect at all. Taking `transport.stateless`
      // directly made those two settable but inert: the value was written into the overrides and
      // never read again, so the server stayed stateful no matter what the operator configured.
      const resolvedStateless = resolvedConfig.MCP_STATELESS;

      const app = createExpressApp(sessionFactory, sessionManager, {
        stateless: resolvedStateless,
        eventStore: transport.eventStore,
        enableJsonResponse: resolvedJsonResponse,
        health: this.options.health,
        auth: this.options.auth,
        configureApp: this.options.configureHttpApp,
        trustProxy,
        corsOrigin: resolvedConfig.MCP_CORS_ORIGIN,
        corsCredentials: resolvedConfig.MCP_CORS_CREDENTIALS,
        helmetHsts: resolvedConfig.MCP_HELMET_HSTS,
        tlsTerminated: transport.mode === "https",
        helmetCsp: resolvedConfig.MCP_HELMET_CSP,
        helmetFrameOptions: resolvedConfig.MCP_HELMET_FRAME_OPTIONS,
        bodyLimit: resolvedConfig.MCP_BODY_SIZE_LIMIT,
      });

      return startHttpTransport(app, { transport });
    }

    return startStdioTransport(sessionFactory, sessionManager);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal Handling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register process signal handlers for graceful shutdown.
   *
   * Uses `process.once()` for each signal. Handler references are stored
   * so they can be removed in `stop()` to prevent accumulation when the
   * server is restarted within the same process.
   */
  private setupSignalHandlers(): void {
    // Clean up any leftover handlers from a previous start() cycle
    this.removeSignalHandlers();

    const shutdownConfig: ShutdownConfig = {
      ...DEFAULT_SHUTDOWN_CONFIG,
      ...this.options.shutdown,
    };

    const signals = shutdownConfig.signals ?? DEFAULT_SIGNALS;

    for (const signal of signals) {
      const handler = (): void => {
        logger.info(RuntimeLogMessages.SHUTDOWN_SIGNAL, signal);
        void this.gracefulStop(shutdownConfig)
          .then(() => {
            process.exit(0);
          })
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(RuntimeLogMessages.SHUTDOWN_FAILED, reason);
            process.exit(1);
          });
      };
      this.signalHandlers.push({ signal, handler });
      process.once(signal, handler);
    }

    // Register process error handlers for unhandled rejections and exceptions.
    // These ensure a graceful shutdown instead of a hard crash.
    this.setupProcessErrorHandlers(shutdownConfig);
  }

  /**
   * Register handlers for unhandled promise rejections and uncaught exceptions.
   *
   * Both trigger a graceful shutdown followed by `process.exit(1)`. A guard
   * prevents concurrent shutdown attempts when multiple errors arrive or
   * a signal arrives simultaneously.
   */
  private setupProcessErrorHandlers(shutdownConfig: ShutdownConfig): void {
    const shutdownOnError = (logMessage: string, error: unknown): void => {
      if (this.shutdownInProgress) return;
      this.shutdownInProgress = true;

      const reason = error instanceof Error ? error.message : String(error);
      logger.error(logMessage, reason);

      void this.gracefulStop(shutdownConfig).finally(() => {
        process.exit(1);
      });
    };

    const rejectionHandler = (reason: unknown): void => {
      shutdownOnError(RuntimeLogMessages.UNHANDLED_REJECTION, reason);
    };

    const exceptionHandler = (error: unknown): void => {
      shutdownOnError(RuntimeLogMessages.UNCAUGHT_EXCEPTION, error);
    };

    process.on("unhandledRejection", rejectionHandler);
    process.on("uncaughtException", exceptionHandler);

    this.processErrorHandlers.push(
      { event: "unhandledRejection", handler: rejectionHandler },
      { event: "uncaughtException", handler: exceptionHandler },
    );
  }

  /**
   * Remove previously registered signal handlers.
   *
   * Prevents handler accumulation when `start()` is called multiple times
   * (e.g., after `stop()` → `start()` restart).
   */
  private removeSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    for (const { event, handler } of this.processErrorHandlers) {
      process.removeListener(event, handler);
    }
    this.processErrorHandlers = [];
    this.shutdownInProgress = false;
  }

  /**
   * Perform graceful shutdown with optional timeout enforcement.
   *
   * If `forceExitOnTimeout` is enabled, forces `process.exit(1)` when
   * the shutdown exceeds the configured timeout. The timeout is unref'd
   * to avoid keeping the event loop alive if shutdown completes in time.
   */
  private async gracefulStop(config: ShutdownConfig): Promise<void> {
    if (!config.forceExitOnTimeout) {
      await this.stop();
      return;
    }

    // Race stop() against a timeout. If stop() completes in time, the timeout
    // is cleared. If the timeout fires first, force-exit with a short drain
    // period for pending I/O (logger flush, OTEL export).
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(RuntimeLogMessages.SHUTDOWN_FORCED);
      // Give pending log writes a brief window to flush before hard exit.
      // setImmediate ensures current I/O callbacks can complete.
      setImmediate(() => process.exit(1));
    }, config.timeoutMs).unref();

    let stopError: unknown;
    try {
      await this.stop();
    } catch (error) {
      stopError = error;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut is set asynchronously by the timeout callback; not statically const-false.
      if (!timedOut) {
        clearTimeout(timeout);
      }
    }

    // Check timeout BEFORE re-throwing stop errors — if the timeout already
    // scheduled setImmediate(exit(1)), the promise resolution (microtask)
    // can race ahead and trigger .then(exit(0)) first. Throwing here
    // ensures the caller's .catch(exit(1)) wins.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut is set asynchronously by the timeout callback; not statically const-false.
    if (timedOut) {
      throw new Error("Shutdown completed after timeout — forcing exit(1)");
    }

    if (stopError instanceof Error) {
      throw stopError;
    } else if (stopError !== undefined) {
      throw new Error(typeof stopError === "string" ? stopError : "Shutdown failed");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transitions the server state and logs the change.
   */
  private transitionState(newState: ServerState): void {
    const previous = this.serverState;
    this.serverState = newState;
    logger.debug(RuntimeLogMessages.STATE_TRANSITION, previous, newState);
  }

  /**
   * Invokes a lifecycle hook with error logging.
   * Hook errors are logged as warnings but do not abort the lifecycle.
   */
  private async invokeLifecycleHook(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(RuntimeLogMessages.LIFECYCLE_HOOK_ERROR, name, msg);
    }
  }

  /**
   * Log the auth configuration at startup.
   *
   * Warns when auth is configured with stdio (unsupported)
   * or when auth is used without trust proxy behind a reverse proxy.
   */
  private logAuthConfiguration(): void {
    const auth = this.options.auth;
    if (!auth) return;

    if (this.transportMode === "stdio") {
      logger.warn(RuntimeLogMessages.AUTH_STDIO_WARNING);
      return;
    }

    if (isFullOAuthProvider(auth.provider)) {
      logger.info(RuntimeLogMessages.AUTH_OAUTH_ENABLED, auth.issuerUrl?.toString() ?? "not set");
    } else {
      logger.info(RuntimeLogMessages.AUTH_BEARER_ENABLED);
    }

    // Warn about missing trust proxy when auth is enabled
    const config = getFrameworkConfig();
    if (!config.MCP_TRUST_PROXY) {
      logger.warn(RuntimeLogMessages.AUTH_NO_TRUST_PROXY);
    }
  }

  /**
   * Dispose the auth provider if it has a `dispose()` method.
   */
  private async disposeAuthProvider(): Promise<void> {
    const provider = this.options.auth?.provider;
    if (provider && "dispose" in provider && typeof provider.dispose === "function") {
      // Support both sync and async dispose() implementations
      await provider.dispose();
      logger.debug(RuntimeLogMessages.AUTH_PROVIDER_DISPOSED);
    }
  }

  /**
   * Dispose the transport's event store if it has a `dispose()` method.
   *
   * `EventStore` doesn't declare `dispose()` (the SDK interface has no shutdown hook), so
   * this is a duck-typed opportunistic call — implementations like `createInMemoryEventStore()`
   * that hold a cleanup timer can still be released without the consumer keeping a reference.
   */
  private async disposeEventStore(): Promise<void> {
    const transport = this.options.transport;
    const eventStore = transport && isHttpTransport(transport) ? transport.eventStore : undefined;
    if (eventStore && "dispose" in eventStore && typeof eventStore.dispose === "function") {
      // Support both sync and async dispose() implementations
      await eventStore.dispose();
      logger.debug(RuntimeLogMessages.EVENT_STORE_DISPOSED);
    }
  }
}
