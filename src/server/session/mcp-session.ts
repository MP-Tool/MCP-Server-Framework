/**
 * MCP Session
 *
 * Represents a single MCP client session. Each session wraps an SDK McpServer
 * instance with SDK-native cancellation and progress support.
 *
 * Key responsibilities:
 * - One client = one session = one SDK McpServer (1:1 per MCP spec)
 * - Delegates tool/resource/prompt/task registration to registrar modules
 * - Manages per-session resource subscriptions
 * - Uses SDK's native AbortSignal for cancellation (per-request, protocol-managed)
 *
 * @module server/session/mcp-session
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  SetLevelRequestSchema,
  type Icon,
} from "@modelcontextprotocol/sdk/types.js";

import type { TaskStore, TaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";

import type {
  HandlersConfig,
  ToolDefinition,
  TaskToolDefinition,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  PromptDefinition,
} from "../../mcp/types/index.js";
import { setupPingHandler } from "../../mcp/handlers/index.js";
import {
  ToolRegistry,
  ResourceRegistry,
  PromptRegistry,
  TaskToolRegistry,
} from "../../mcp/capabilities/registry/index.js";
import { hasAllRequiredScopes } from "../../mcp/capabilities/registry/scope-enforcement.js";
import { logger as frameworkLogger } from "../../logger/index.js";
import type { SecretScrubber } from "../../logger/index.js";
import type { LogNotificationHandler, McpLogLevel } from "../../logger/core/index.js";
import { MCP_LEVEL_ORDER } from "../../logger/core/constants.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Server identity, shared by every option layer (`createServer()` → builder →
 * session factory → session) instead of re-declaring the same four fields.
 */
export interface ServerIdentity {
  /** Server name displayed to MCP clients */
  readonly name: string;
  /** Server version */
  readonly version: string;
  /** Human-friendly display name, distinct from `name` */
  readonly title?: string | undefined;
  /** Icons representing this server */
  readonly icons?: Icon[] | undefined;
}

/**
 * Per-session runtime settings, threaded unchanged from the server build into
 * each session — shared by `SessionFactoryConfig` and `McpSessionOptions` so
 * the two layers cannot drift apart.
 */
export interface SessionRuntimeOptions {
  /** Protocol handler hooks */
  readonly handlers?: HandlersConfig | undefined;
  /** Whether this session operates in stateless mode */
  readonly stateless?: boolean | undefined;
  /**
   * Task store for experimental task support.
   *
   * When provided, enables `tasks/*` protocol methods and allows
   * task-based tools to use `extra.taskStore` in their handlers.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  readonly taskStore?: TaskStore | undefined;
  /**
   * Task message queue for experimental task support.
   *
   * Manages server-initiated messages that will be delivered through
   * the `tasks/result` response stream.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  readonly taskMessageQueue?: TaskMessageQueue | undefined;
  /**
   * Central tool-result secret scrubber (shared per server build). Applied to
   * every tool and task-tool result bound on this session. `undefined`
   * disables result scrubbing.
   */
  readonly resultScrubber?: SecretScrubber | undefined;
}

/**
 * Options for creating an McpSession instance.
 */
export interface McpSessionOptions extends ServerIdentity, SessionRuntimeOptions {
  /** Pre-built SDK capabilities (computed once by the session factory) */
  readonly capabilities: Record<string, unknown>;
}

/**
 * Callback for session close events.
 */
export type CloseCallback = () => void;

/**
 * Callback for session error events.
 */
export type ErrorCallback = (error: Error) => void;

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "mcp-session";

const LogMessages = {
  SESSION_CREATED: "MCP session created: %s v%s",
  SESSION_CLOSED: "MCP session closed",
  SESSION_ERROR: "MCP session error: %s",
  // Subscriptions
  SUBSCRIPTION_HANDLERS_REGISTERED: "Subscription handlers registered",
  RESOURCE_SUBSCRIBED: "Subscribed to resource: %s",
  RESOURCE_UNSUBSCRIBED: "Unsubscribed from resource: %s",
  RESOURCE_UPDATED_SENT: "Sent resource updated notification: %s",
  RESOURCE_UPDATED_SKIPPED: "Skipped resource updated (not subscribed): %s",
  // Logging
  LOG_LEVEL_SET: "Client requested log level: %s",
  LOG_SET_LEVEL_HANDLER_REGISTERED: "logging/setLevel handler registered",
  // Scope-filtered list handlers
  SCOPE_FILTER_INSTALLED:
    "Scope-filtered list handlers installed (tools: %d, resources: %d, templates: %d, prompts: %d scoped)",
  SCOPE_FILTER_SKIPPED: "No scoped capabilities — scope-filtered list handlers not needed",
} as const;

// ============================================================================
// McpSession Class
// ============================================================================

/**
 * A managed MCP client session.
 *
 * Each session wraps an SDK McpServer instance. Cancellation and progress
 * are handled natively by the SDK — no additional tracking layer needed.
 *
 * @example
 * ```typescript
 * const session = new McpSession({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   capabilities: { tools: {} },
 * });
 *
 * // Access underlying SDK server for transport connection
 * await session.sdk.connect(transport);
 * ```
 */
export class McpSession implements LogNotificationHandler {
  /** The underlying MCP SDK server instance */
  public readonly sdk: McpServer;

  /** Session options */
  public readonly options: Readonly<McpSessionOptions>;

  /** URIs this session has subscribed to for resource update notifications */
  private readonly subscribedURIs = new Set<string>();

  /** Client-requested minimum log level for notifications/message (per-session, per MCP spec) */
  private mcpLogMinLevel: McpLogLevel = "debug";

  private readonly logger = frameworkLogger.child({ component: LOG_COMPONENT });

  private onCloseCallback?: CloseCallback | undefined;
  private onErrorCallback?: ErrorCallback | undefined;

  /**
   * Creates a new McpSession instance.
   *
   * Cancellation is handled natively by the SDK's Protocol layer
   * (per-request AbortController, keyed by real JSON-RPC request ID).
   * Progress reporting uses the SDK's extra.sendNotification with
   * rate-limiting applied by createProgressReporter().
   *
   * @param options - Session configuration options
   */
  constructor(options: McpSessionOptions) {
    this.options = Object.freeze({ ...options });

    // Create the underlying SDK server with pre-built capabilities
    this.sdk = new McpServer(
      {
        name: options.name,
        version: options.version,
        ...(options.title && { title: options.title }),
        ...(options.icons && { icons: options.icons }),
      },
      {
        capabilities: options.capabilities,
        ...(options.taskStore && { taskStore: options.taskStore }),
        ...(options.taskMessageQueue && {
          taskMessageQueue: options.taskMessageQueue,
        }),
      },
    );

    // Setup protocol handlers (only ping — cancellation is SDK-native)
    setupPingHandler(this.sdk, options.handlers?.onPing);

    // Setup lifecycle callbacks
    this.setupLifecycleCallbacks();

    this.logger.trace(LogMessages.SESSION_CREATED, options.name, options.version);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /** Server name */
  get name(): string {
    return this.options.name;
  }

  /** Server version */
  get version(): string {
    return this.options.version;
  }

  /**
   * Set callback for session close events.
   */
  onClose(callback: CloseCallback): this {
    this.onCloseCallback = callback;
    return this;
  }

  /**
   * Set callback for session error events.
   */
  onError(callback: ErrorCallback): this {
    this.onErrorCallback = callback;
    return this;
  }

  /**
   * Clean up session resources.
   *
   * Closes the underlying SDK McpServer, releasing protocol-level resources
   * (pending requests, open streams, registered handlers). This is the
   * counterpart to `sdk.connect(transport)` — every connected session
   * should be disposed when no longer needed.
   *
   * Called by:
   * - SessionManager (stateful sessions — on close/closeAll)
   * - StreamableHttpTransport (stateless sessions — on response close)
   *
   * Safe to call multiple times — sdk.close() is idempotent.
   */
  async dispose(): Promise<void> {
    try {
      await this.sdk.close();
      // No logging here — sdk.close() triggers onclose/onerror callbacks
      // which are the canonical logging source (setupLifecycleCallbacks)
    } catch (err) {
      // sdk.close() normally fires onerror before throwing, which logs at ERROR level.
      // If it throws before onerror fires we'd lose the error silently — log here as fallback.
      this.logger.error("McpSession dispose error during sdk.close()", err);
    } finally {
      // Release callback references to allow GC of captured closures
      this.onCloseCallback = undefined;
      this.onErrorCallback = undefined;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SDK Registration — Delegates to Registry.bindToSdk()
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers all tools with the MCP SDK server.
   * Delegates to ToolRegistry.bindToSdk().
   */
  registerTools(tools: readonly ToolDefinition[]): void {
    ToolRegistry.bindToSdk(this.sdk, tools, {
      logger: this.logger,
      stateless: this.options.stateless ?? false,
      logNotificationHandler: this,
      resultScrubber: this.options.resultScrubber,
    });
  }

  /**
   * Registers task tools with the MCP SDK's experimental tasks API.
   * Delegates to TaskToolRegistry.bindToSdk().
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  registerTaskTools(taskTools: readonly TaskToolDefinition[]): void {
    TaskToolRegistry.bindToSdk(this.sdk, taskTools, {
      logger: this.logger,
      stateless: this.options.stateless ?? false,
      resultScrubber: this.options.resultScrubber,
    });
  }

  /**
   * Registers all resources (static + templates) with the MCP SDK server.
   * Delegates to ResourceRegistry.bindToSdk().
   */
  registerResources(
    resources: readonly ResourceStaticDefinition[],
    templates: readonly ResourceTemplateDefinition[],
  ): void {
    ResourceRegistry.bindToSdk(this.sdk, resources, templates, {
      logger: this.logger,
      resultScrubber: this.options.resultScrubber,
    });
  }

  /**
   * Registers all prompts with the MCP SDK server.
   * Delegates to PromptRegistry.bindToSdk().
   */
  registerPrompts(prompts: readonly PromptDefinition[]): void {
    PromptRegistry.bindToSdk(this.sdk, prompts, {
      logger: this.logger,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SDK Registration — Resource Subscriptions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers request handlers for `resources/subscribe` and `resources/unsubscribe`.
   *
   * @sdk-constraint — The SDK's high-level `McpServer` does not handle subscription
   * requests. This uses the low-level `Server.setRequestHandler()` API to register
   * handlers for the subscribe/unsubscribe JSON-RPC methods.
   *
   * Subscription tracking is per-session (this `McpSession` instance).
   * When `notifyResourceUpdated(uri)` is called, only sessions that
   * subscribed to the given URI receive `notifications/resources/updated`.
   *
   * In stateless mode, subscriptions are not meaningful (no persistent session),
   * so this method should not be called for stateless sessions.
   */
  registerSubscriptionHandlers(): void {
    this.sdk.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      this.subscribedURIs.add(uri);
      this.logger.trace(LogMessages.RESOURCE_SUBSCRIBED, uri);
      return {};
    });

    this.sdk.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      const { uri } = request.params;
      this.subscribedURIs.delete(uri);
      this.logger.trace(LogMessages.RESOURCE_UNSUBSCRIBED, uri);
      return {};
    });

    this.logger.trace(LogMessages.SUBSCRIPTION_HANDLERS_REGISTERED);
  }

  /**
   * Sends a `notifications/resources/updated` notification to this session's client
   * if the session has subscribed to the given URI.
   *
   * @param uri - The resource URI that was updated
   */
  async sendResourceUpdated(uri: string): Promise<void> {
    if (!this.subscribedURIs.has(uri)) {
      this.logger.trace(LogMessages.RESOURCE_UPDATED_SKIPPED, uri);
      return;
    }

    try {
      await this.sdk.server.sendResourceUpdated({ uri });
      this.logger.trace(LogMessages.RESOURCE_UPDATED_SENT, uri);
    } catch (error) {
      this.logger.warn("Error sending resource updated for %s: %s", uri, String(error));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LogNotificationHandler — Bridge logger → MCP client
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sends a log notification to the connected MCP client.
   * Implements {@link LogNotificationHandler} so this session can be
   * registered directly with the MCP notification logger.
   *
   * Respects the per-session minimum level set by the client via `logging/setLevel`.
   * Messages below the requested level are silently dropped.
   */
  async sendLogNotification(level: McpLogLevel, message: string): Promise<void> {
    if (MCP_LEVEL_ORDER.indexOf(level) < MCP_LEVEL_ORDER.indexOf(this.mcpLogMinLevel)) {
      return;
    }
    await this.sdk.server.sendLoggingMessage({ level, data: message });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SDK Registration — logging/setLevel
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Registers a request handler for `logging/setLevel`.
   *
   * Per MCP Spec: When the server declares `logging: {}` capability, clients
   * can send `logging/setLevel` to control which log notifications they receive.
   * The handler stores the requested level per-session so that each client
   * independently controls its own notification verbosity.
   *
   * @param defaultMinLevel - Initial minimum level (defaults to "debug" = send all)
   */
  registerSetLevelHandler(defaultMinLevel?: McpLogLevel): void {
    if (defaultMinLevel !== undefined) {
      this.mcpLogMinLevel = defaultMinLevel;
    }

    this.sdk.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      // @type-narrowing — SDK validates params against SetLevelRequestParamsSchema
      const level = request.params.level;
      this.mcpLogMinLevel = level;
      this.logger.debug(LogMessages.LOG_LEVEL_SET, level);
      return {};
    });

    this.logger.trace(LogMessages.LOG_SET_LEVEL_HANDLER_REGISTERED);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scope-Filtered List Handlers (Opt-in RBAC for capability listings)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Overrides `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list`
   * handlers to filter out entries whose `requiredScopes` are not satisfied by the
   * requesting user's token scopes.
   *
   * This wraps the SDK's original handlers — the full list is constructed by the SDK,
   * then filtered before being returned to the client.
   *
   * Call this AFTER all tools/resources/prompts have been registered via `registerTools()` etc.
   *
   * @param options - All registered definitions (used to build scope lookup maps)
   */
  registerScopeFilteredListHandlers(options: {
    tools: readonly ToolDefinition[];
    resources: readonly ResourceStaticDefinition[];
    templates: readonly ResourceTemplateDefinition[];
    prompts: readonly PromptDefinition[];
  }): void {
    // Build scope lookup maps
    const scopeMapOf = <T extends { requiredScopes?: readonly string[] | undefined }>(
      items: readonly T[],
      keyOf: (item: T) => string,
    ): Map<string, readonly string[]> => {
      const map = new Map<string, readonly string[]>();
      for (const item of items) {
        if (item.requiredScopes?.length) map.set(keyOf(item), item.requiredScopes);
      }
      return map;
    };
    const toolScopes = scopeMapOf(options.tools, (t) => t.name);
    const resourceScopes = scopeMapOf(options.resources, (r) => r.uri);
    const templateScopes = scopeMapOf(options.templates, (t) => t.name);
    const promptScopes = scopeMapOf(options.prompts, (p) => p.name);

    // Skip if nothing has scopes
    const totalScoped = toolScopes.size + resourceScopes.size + templateScopes.size + promptScopes.size;
    if (totalScoped === 0) {
      this.logger.trace(LogMessages.SCOPE_FILTER_SKIPPED);
      return;
    }

    // @sdk-constraint — Scope-based list filtering relies on the private `_requestHandlers`
    // Map on the SDK's Protocol class. This is NOT a public SDK API and may break on any
    // SDK minor version bump. If the field is absent or renamed, filtering silently degrades
    // to no-op (tools/resources/prompts are visible regardless of token scopes).
    //
    // Long-term fix: request a public `setListHandler` override API from the SDK maintainers.
    const rawHandlers = (this.sdk.server as unknown as Record<string, unknown>)._requestHandlers;

    if (!rawHandlers || !(rawHandlers instanceof Map)) {
      this.logger.error(
        "Scope-filtered list handlers DISABLED: SDK _requestHandlers is %s — " +
          "prompts will be visible to ALL authenticated sessions regardless of token scopes. " +
          "This may indicate an incompatible SDK version.",
        rawHandlers === undefined ? "undefined" : typeof rawHandlers,
      );
      return;
    }

    const handlers = rawHandlers as Map<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;

    const getTokenScopes = (extra: Record<string, unknown>): readonly string[] => {
      const authInfo = extra.authInfo as { scopes?: readonly string[] } | undefined;
      return authInfo?.scopes ?? [];
    };

    // One generic wrapper for all four list methods — they differ only in the
    // result key, the identifying item field, and the scope lookup map.
    const installScopeFilter = (
      method: string,
      resultKey: string,
      itemKey: string,
      scopeMap: ReadonlyMap<string, readonly string[]>,
    ): void => {
      if (scopeMap.size === 0) return;
      const original = handlers.get(method);
      if (!original) return;
      handlers.set(method, async (request: unknown, extra: unknown) => {
        const result = await original(request, extra);
        const tokenScopes = getTokenScopes(extra as Record<string, unknown>);
        const items = (result[resultKey] ?? []) as Array<Record<string, string>>;
        return {
          ...result,
          [resultKey]: items.filter((item) => {
            const required = scopeMap.get(item[itemKey] ?? "");
            return !required || hasAllRequiredScopes(required, tokenScopes);
          }),
        };
      });
    };

    installScopeFilter("tools/list", "tools", "name", toolScopes);
    installScopeFilter("resources/list", "resources", "uri", resourceScopes);
    installScopeFilter("resources/templates/list", "resourceTemplates", "name", templateScopes);
    installScopeFilter("prompts/list", "prompts", "name", promptScopes);

    this.logger.debug(
      LogMessages.SCOPE_FILTER_INSTALLED,
      toolScopes.size,
      resourceScopes.size,
      templateScopes.size,
      promptScopes.size,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sets up lifecycle callbacks on the underlying SDK server.
   */
  private setupLifecycleCallbacks(): void {
    let closed = false;
    this.sdk.server.onclose = () => {
      if (closed) return;
      closed = true;
      this.logger.trace(LogMessages.SESSION_CLOSED);
      this.onCloseCallback?.();
    };

    this.sdk.server.onerror = (error: Error) => {
      this.logger.error(LogMessages.SESSION_ERROR, error.message);
      this.onErrorCallback?.(error);
    };
  }
}
