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
import type { LogNotificationHandler, McpLogLevel } from "../../logger/index.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating an McpSession instance.
 */
export interface McpSessionOptions {
  /** Server name */
  name: string;
  /** Server version */
  version: string;
  /** Pre-built SDK capabilities (from builder) */
  capabilities: Record<string, unknown>;
  /** Protocol handler hooks */
  handlers?: HandlersConfig | undefined;
  /** Whether this session operates in stateless mode */
  stateless?: boolean | undefined;
  /**
   * Task store for experimental task support.
   *
   * When provided, enables `tasks/*` protocol methods and allows
   * task-based tools to use `extra.taskStore` in their handlers.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  taskStore?: TaskStore | undefined;
  /**
   * Task message queue for experimental task support.
   *
   * Manages server-initiated messages that will be delivered through
   * the `tasks/result` response stream.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  taskMessageQueue?: TaskMessageQueue | undefined;
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
      { name: options.name, version: options.version },
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
    } catch {
      // Swallowed — onerror callback already logs at ERROR level
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
   */
  async sendLogNotification(level: McpLogLevel, message: string): Promise<void> {
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
   * The handler updates the McpNotificationLogger's minimum level so that
   * only messages at or above the requested level are forwarded.
   *
   * @param onSetLevel - Callback to apply the requested level (typically mcpLogger.setMinLevel)
   */
  registerSetLevelHandler(onSetLevel: (level: McpLogLevel) => void): void {
    this.sdk.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      // @type-narrowing — SDK validates params against SetLevelRequestParamsSchema
      const level = request.params.level as McpLogLevel;
      onSetLevel(level);
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
    const toolScopes = new Map<string, readonly string[]>();
    for (const t of options.tools) {
      if (t.requiredScopes?.length) toolScopes.set(t.name, t.requiredScopes);
    }
    const resourceScopes = new Map<string, readonly string[]>();
    for (const r of options.resources) {
      if (r.requiredScopes?.length) resourceScopes.set(r.uri, r.requiredScopes);
    }
    const templateScopes = new Map<string, readonly string[]>();
    for (const t of options.templates) {
      if (t.requiredScopes?.length) templateScopes.set(t.name, t.requiredScopes);
    }
    const promptScopes = new Map<string, readonly string[]>();
    for (const p of options.prompts) {
      if (p.requiredScopes?.length) promptScopes.set(p.name, p.requiredScopes);
    }

    // Skip if nothing has scopes
    const totalScoped = toolScopes.size + resourceScopes.size + templateScopes.size + promptScopes.size;
    if (totalScoped === 0) {
      this.logger.trace(LogMessages.SCOPE_FILTER_SKIPPED);
      return;
    }

    // @sdk-constraint — _requestHandlers is private on Protocol but accessible at runtime.
    // We wrap the SDK's original list handlers to add scope-based filtering.
    // Guard: if the SDK changes its internal structure, fail gracefully instead of crashing.
    const rawHandlers = (this.sdk.server as unknown as Record<string, unknown>)._requestHandlers;

    if (!rawHandlers || !(rawHandlers instanceof Map)) {
      this.logger.error(
        "Cannot install scope-filtered list handlers: SDK _requestHandlers is %s. " +
          "This may indicate an incompatible SDK version — scope filtering is disabled.",
        rawHandlers === undefined ? "undefined" : typeof rawHandlers,
      );
      return;
    }

    const handlers = rawHandlers as Map<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;

    const getTokenScopes = (extra: Record<string, unknown>): readonly string[] => {
      const authInfo = extra.authInfo as { scopes?: readonly string[] } | undefined;
      return authInfo?.scopes ?? [];
    };

    // Override tools/list
    if (toolScopes.size > 0) {
      const original = handlers.get("tools/list");
      if (original) {
        handlers.set("tools/list", async (request: unknown, extra: unknown) => {
          const result = await original(request, extra);
          const tokenScopes = getTokenScopes(extra as Record<string, unknown>);
          const tools = (result.tools ?? []) as Array<{ name: string }>;
          return {
            ...result,
            tools: tools.filter((tool) => {
              const required = toolScopes.get(tool.name);
              return !required || hasAllRequiredScopes(required, tokenScopes);
            }),
          };
        });
      }
    }

    // Override resources/list (filter static resources by URI)
    if (resourceScopes.size > 0) {
      const original = handlers.get("resources/list");
      if (original) {
        handlers.set("resources/list", async (request: unknown, extra: unknown) => {
          const result = await original(request, extra);
          const tokenScopes = getTokenScopes(extra as Record<string, unknown>);
          const resources = (result.resources ?? []) as Array<{
            uri: string;
          }>;
          return {
            ...result,
            resources: resources.filter((resource) => {
              const required = resourceScopes.get(resource.uri);
              return !required || hasAllRequiredScopes(required, tokenScopes);
            }),
          };
        });
      }
    }

    // Override resources/templates/list (filter by template name)
    if (templateScopes.size > 0) {
      const original = handlers.get("resources/templates/list");
      if (original) {
        handlers.set("resources/templates/list", async (request: unknown, extra: unknown) => {
          const result = await original(request, extra);
          const tokenScopes = getTokenScopes(extra as Record<string, unknown>);
          const templates = (result.resourceTemplates ?? []) as Array<{
            name: string;
          }>;
          return {
            ...result,
            resourceTemplates: templates.filter((template) => {
              const required = templateScopes.get(template.name);
              return !required || hasAllRequiredScopes(required, tokenScopes);
            }),
          };
        });
      }
    }

    // Override prompts/list
    if (promptScopes.size > 0) {
      const original = handlers.get("prompts/list");
      if (original) {
        handlers.set("prompts/list", async (request: unknown, extra: unknown) => {
          const result = await original(request, extra);
          const tokenScopes = getTokenScopes(extra as Record<string, unknown>);
          const prompts = (result.prompts ?? []) as Array<{ name: string }>;
          return {
            ...result,
            prompts: prompts.filter((prompt) => {
              const required = promptScopes.get(prompt.name);
              return !required || hasAllRequiredScopes(required, tokenScopes);
            }),
          };
        });
      }
    }

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
