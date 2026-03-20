/**
 * MCP Session Factory
 *
 * Responsible for creating fully-configured MCP sessions with pre-computed
 * capabilities and all registered primitives. Capabilities are computed once
 * at construction time since the input data (tools, resources, prompts) is
 * immutable after server build.
 *
 * Extracted from McpServerInstance to satisfy the Single Responsibility
 * Principle — the server orchestrates lifecycle, the factory creates sessions.
 *
 * @module server/session/session-factory
 */

import type {
  ToolDefinition,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  PromptDefinition,
  TaskToolDefinition,
  HandlersConfig,
} from "../../mcp/types/index.js";
import type { ServerCapabilities } from "../server-options.js";
import type { TaskStore, TaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
} from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { buildCapabilities } from "../../mcp/capabilities/index.js";
import { McpSession } from "./mcp-session.js";
import { logger as frameworkLogger, mcpLogger } from "../../logger/index.js";

// ============================================================================
// Constants
// ============================================================================

const LOG_COMPONENT = "session-factory";

const SessionFactoryLogMessages = {
  FACTORY_CREATED: "Session factory created: %s v%s (%d tools, %d resources, %d prompts)",
  SESSION_CREATED: "New MCP session created",
  SESSION_ERROR: "MCP session error:",
} as const;

const logger = frameworkLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Session Factory Configuration
// ============================================================================

/**
 * Configuration for the MCP session factory.
 *
 * All arrays should be frozen (immutable) after server build.
 * Capabilities are computed once from this config at construction time.
 */
export interface SessionFactoryConfig {
  /** Server name passed to each MCP session */
  readonly name: string;

  /** Server version passed to each MCP session */
  readonly version: string;

  /** Server capabilities configuration */
  readonly capabilities?: ServerCapabilities | undefined;

  /** Custom protocol handler hooks */
  readonly handlers?: HandlersConfig | undefined;

  /** Whether sessions operate in stateless mode */
  readonly stateless?: boolean | undefined;

  /** Tool definitions to register on each session */
  readonly tools: ReadonlyArray<ToolDefinition>;

  /** Static resource definitions to register on each session */
  readonly resources: ReadonlyArray<ResourceStaticDefinition>;

  /** Resource template definitions to register on each session */
  readonly resourceTemplates: ReadonlyArray<ResourceTemplateDefinition>;

  /** Prompt definitions to register on each session */
  readonly prompts: ReadonlyArray<PromptDefinition>;

  /**
   * Task tool definitions to register on each session.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  readonly taskTools: ReadonlyArray<TaskToolDefinition>;

  /**
   * Task store for experimental task support.
   *
   * When task tools are present, this is automatically set to
   * `InMemoryTaskStore` unless a custom implementation is provided.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  readonly taskStore?: TaskStore | undefined;

  /**
   * Task message queue for experimental task support.
   *
   * When task tools are present, this is automatically set to
   * `InMemoryTaskMessageQueue` unless a custom implementation is provided.
   *
   * @experimental MCP Tasks is an experimental SDK feature
   */
  readonly taskMessageQueue?: TaskMessageQueue | undefined;

  /**
   * When `true`, list handlers filter capabilities by user scopes.
   *
   * Only effective when definitions have `requiredScopes`.
   * Default: `false` (spec-konform — all capabilities listed).
   */
  readonly scopeFilterCapabilities?: boolean | undefined;
}

// ============================================================================
// Session Factory Implementation
// ============================================================================

/**
 * Creates fully-configured MCP sessions.
 *
 * Capabilities are pre-computed once in the constructor since the input
 * data is immutable after server build. Each `create()` call produces
 * a new McpSession with all primitives registered — ready for transport
 * connection.
 *
 * @internal Created by McpServerBuilder — do not instantiate directly.
 *
 * @example
 * ```typescript
 * const factory = new McpSessionFactory({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   tools: frozenToolArray,
 *   resources: frozenResourceArray,
 *   resourceTemplates: frozenTemplateArray,
 *   prompts: frozenPromptArray,
 * });
 *
 * const session = factory.create(); // Ready for transport.connect()
 * ```
 */
export class McpSessionFactory {
  /** Pre-computed SDK capabilities (immutable after construction) */
  private readonly computedCapabilities: Record<string, unknown>;

  /** Task store instance (shared across all sessions) */
  private readonly taskStore: TaskStore | undefined;

  /** Task message queue instance (shared across all sessions) */
  private readonly taskMessageQueue: TaskMessageQueue | undefined;

  constructor(private readonly config: SessionFactoryConfig) {
    // Compute capabilities ONCE — input data is immutable
    this.computedCapabilities = buildCapabilities(
      config.capabilities,
      config.tools,
      config.resources,
      config.resourceTemplates,
      config.prompts,
      config.taskTools,
    );

    // Auto-create InMemoryTaskStore when task tools exist but no store provided
    this.taskStore = config.taskStore ?? (config.taskTools.length > 0 ? new InMemoryTaskStore() : undefined);

    // Auto-create InMemoryTaskMessageQueue when task tools exist but no queue provided
    this.taskMessageQueue =
      config.taskMessageQueue ?? (config.taskTools.length > 0 ? new InMemoryTaskMessageQueue() : undefined);

    logger.trace(
      SessionFactoryLogMessages.FACTORY_CREATED,
      config.name,
      config.version,
      config.tools.length,
      config.resources.length + config.resourceTemplates.length,
      config.prompts.length,
    );
  }

  /**
   * Creates a new MCP session with all registered primitives.
   *
   * Called once for stdio mode, or per-client for HTTP mode.
   * Each session wraps one SDK McpServer (1:1 per MCP spec).
   *
   * Session lifecycle is managed by the SessionManager —
   * this factory only creates and configures sessions.
   */
  create(): McpSession {
    const session = new McpSession({
      name: this.config.name,
      version: this.config.version,
      capabilities: this.computedCapabilities,
      handlers: this.config.handlers,
      stateless: this.config.stateless,
      ...(this.taskStore && { taskStore: this.taskStore }),
      ...(this.taskMessageQueue && { taskMessageQueue: this.taskMessageQueue }),
    });

    // Log session errors (lifecycle managed by SessionManager, not here)
    session.onError((error) => {
      logger.error(SessionFactoryLogMessages.SESSION_ERROR, error);
    });

    // Register all MCP primitives directly on the session
    session.registerTools(this.config.tools);
    session.registerResources(this.config.resources, this.config.resourceTemplates);
    session.registerPrompts(this.config.prompts);
    session.registerTaskTools(this.config.taskTools);

    // Register subscription handlers when resources.subscribe capability is enabled
    // and session is stateful (subscriptions require persistent sessions)
    const resourceCaps = this.computedCapabilities.resources;
    const hasSubscribe =
      typeof resourceCaps === "object" &&
      resourceCaps !== null &&
      "subscribe" in resourceCaps &&
      // @type-narrowing — runtime checks above validate resourceCaps is a non-null object with 'subscribe'
      (resourceCaps as Record<string, unknown>).subscribe === true;

    if (hasSubscribe && !this.config.stateless) {
      session.registerSubscriptionHandlers();
    }

    // Register logging/setLevel handler when logging capability is enabled
    const hasLogging = "logging" in this.computedCapabilities && this.computedCapabilities.logging != null;
    if (hasLogging) {
      session.registerSetLevelHandler((level) => mcpLogger.setMinLevel(level));
    }

    // Install scope-filtered list handlers (opt-in via auth.scopeFilterCapabilities)
    if (this.config.scopeFilterCapabilities) {
      session.registerScopeFilteredListHandlers({
        tools: this.config.tools,
        resources: this.config.resources,
        templates: this.config.resourceTemplates,
        prompts: this.config.prompts,
      });
    }

    logger.debug(SessionFactoryLogMessages.SESSION_CREATED);

    return session;
  }
}
