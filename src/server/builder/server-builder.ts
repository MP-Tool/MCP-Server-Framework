/**
 * MCP Server Builder
 *
 * Provides a fluent, declarative API for constructing MCP servers.
 * This is the main entry point for the framework's server creation pattern.
 *
 * @module server/builder/server-builder
 */

import type { ServerInstance } from "../server-options.js";
import { isHttpTransport } from "../server-options.js";

import type { ServerBuilder, BuilderState } from "./types.js";
import { createBuilderState } from "./types.js";
import type {
  ToolProvider,
  ToolDefinition,
  ResourceProvider,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  PromptProvider,
  PromptDefinition,
  TaskToolProvider,
  TaskToolDefinition,
} from "../../mcp/types/index.js";
import type { ServerOptions } from "../server-options.js";
import { BuilderLogMessages, BUILDER_LOG_COMPONENT } from "./constants.js";
import { McpServerInstance } from "../server-instance.js";
import { McpSessionFactory } from "../session/session-factory.js";
import { validateBuilderState } from "./validation.js";
import type { ValidatedServerOptions } from "./validation.js";
import { collectPrimitives } from "./primitive-collector.js";
import type { CollectedPrimitives } from "./types.js";

import { logger as frameworkLogger } from "../../logger/index.js";

const logger = frameworkLogger.child({ component: BUILDER_LOG_COMPONENT });

// ============================================================================
// Server Builder Implementation
// ============================================================================

/**
 * Fluent builder for constructing MCP servers.
 *
 * Provides a declarative API for configuring all aspects of an MCP server
 * including tools, resources, prompts, transport, and lifecycle hooks.
 *
 * @example Basic usage with tool provider
 * ```typescript
 * const server = new McpServerBuilder()
 *   .withOptions({
 *     name: 'my-mcp-server',
 *     version: '1.0.0',
 *     transport: { mode: 'stdio' },
 *   })
 *   .withToolProvider(myToolRegistry)
 *   .build();
 *
 * await server.start();
 * ```
 */
export class McpServerBuilder implements ServerBuilder {
  private state: BuilderState;
  private built = false;

  constructor() {
    this.state = createBuilderState();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fluent Configuration API
  // ──────────────────────────────────────────────────────────────────────────

  withOptions(options: ServerOptions): ServerBuilder {
    logger.debug(BuilderLogMessages.OPTIONS_CONFIGURED, options.name, options.version);
    this.state.options = options;
    return this;
  }

  withToolProvider(provider: ToolProvider): ServerBuilder {
    this.state.toolProviders.push(provider);
    return this;
  }

  withTools(tools: ReadonlyArray<ToolDefinition>): ServerBuilder {
    this.state.tools.push(...tools);
    return this;
  }

  withResourceProvider(provider: ResourceProvider): ServerBuilder {
    this.state.resourceProviders.push(provider);
    return this;
  }

  withResources(resources: ReadonlyArray<ResourceStaticDefinition>): ServerBuilder {
    this.state.resources.push(...resources);
    return this;
  }

  withResourceTemplates(templates: ReadonlyArray<ResourceTemplateDefinition>): ServerBuilder {
    this.state.resourceTemplates.push(...templates);
    return this;
  }

  withPromptProvider(provider: PromptProvider): ServerBuilder {
    this.state.promptProviders.push(provider);
    return this;
  }

  withPrompts(prompts: ReadonlyArray<PromptDefinition>): ServerBuilder {
    this.state.prompts.push(...prompts);
    return this;
  }

  withTaskToolProvider(provider: TaskToolProvider): ServerBuilder {
    this.state.taskToolProviders.push(provider);
    return this;
  }

  withTaskTools(taskTools: ReadonlyArray<TaskToolDefinition>): ServerBuilder {
    this.state.taskTools.push(...taskTools);
    return this;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build
  // ──────────────────────────────────────────────────────────────────────────

  build(): ServerInstance {
    logger.debug(BuilderLogMessages.BUILD_STARTED);

    // 1. Validate state — throws ConfigurationError on failure
    const options = validateBuilderState(this.state, this.built);

    // 2. Collect & deduplicate primitives from providers + direct registrations
    const primitives = collectPrimitives(this.state);

    // 3. Create server instance
    const instance = this.createServerInstance(options, primitives);

    this.built = true;
    logger.debug(BuilderLogMessages.BUILD_COMPLETED);

    return instance;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates the session factory and server instance from validated options.
   */
  private createServerInstance(options: ValidatedServerOptions, primitives: CollectedPrimitives): ServerInstance {
    const transport = options.transport;
    const stateless = isHttpTransport(transport) ? transport.stateless : undefined;

    const sessionFactory = new McpSessionFactory({
      name: options.name,
      version: options.version,
      capabilities: options.capabilities,
      handlers: options.handlers,
      stateless,
      tools: primitives.tools,
      resources: primitives.resources,
      resourceTemplates: primitives.resourceTemplates,
      prompts: primitives.prompts,
      taskTools: primitives.taskTools,
      scopeFilterCapabilities: options.auth?.scopeFilterCapabilities,
    });

    logger.debug(
      BuilderLogMessages.BUILD_SUMMARY,
      primitives.tools.length,
      primitives.resources.length + primitives.resourceTemplates.length,
      primitives.prompts.length,
    );

    return new McpServerInstance(options, sessionFactory);
  }
}
