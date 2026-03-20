/**
 * Server Builder Types
 *
 * Type definitions for the declarative MCP server builder pattern.
 *
 * @module server/builder/types
 */

import type { ServerOptions, ServerInstance } from "../server-options.js";
import type {
  ToolDefinition,
  ToolProvider,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  ResourceProvider,
  PromptDefinition,
  PromptProvider,
  TaskToolDefinition,
  TaskToolProvider,
} from "../../mcp/types/index.js";

// ============================================================================
// Server Builder Interface
// ============================================================================

/**
 * Fluent builder interface for constructing MCP servers.
 *
 * Provides a declarative, type-safe API for configuring servers.
 *
 * @example
 * ```typescript
 * const server = new McpServerBuilder()
 *   .withOptions({
 *     name: 'my-server',
 *     version: '1.0.0',
 *     transport: { mode: 'stdio' },
 *   })
 *   .withToolProvider(myToolProvider)
 *   .withResourceProvider(myResourceProvider)
 *   .build();
 *
 * await server.start();
 * ```
 */
export interface ServerBuilder {
  /** Configure server options. */
  withOptions(options: ServerOptions): ServerBuilder;

  /** Register a tool provider. */
  withToolProvider(provider: ToolProvider): ServerBuilder;

  /** Register individual tools. */
  withTools(tools: ReadonlyArray<ToolDefinition>): ServerBuilder;

  /** Register a resource provider. */
  withResourceProvider(provider: ResourceProvider): ServerBuilder;

  /** Register individual static resources. */
  withResources(resources: ReadonlyArray<ResourceStaticDefinition>): ServerBuilder;

  /** Register resource templates. */
  withResourceTemplates(templates: ReadonlyArray<ResourceTemplateDefinition>): ServerBuilder;

  /** Register a prompt provider. */
  withPromptProvider(provider: PromptProvider): ServerBuilder;

  /** Register individual prompts. */
  withPrompts(prompts: ReadonlyArray<PromptDefinition>): ServerBuilder;

  /**
   * Register a task tool provider.
   * @experimental MCP Tasks is an experimental SDK feature
   */
  withTaskToolProvider(provider: TaskToolProvider): ServerBuilder;

  /**
   * Register individual task tools.
   * @experimental MCP Tasks is an experimental SDK feature
   */
  withTaskTools(taskTools: ReadonlyArray<TaskToolDefinition>): ServerBuilder;

  /** Build and return the configured server instance. */
  build(): ServerInstance;
}

// ============================================================================
// Internal Builder State
// ============================================================================

/**
 * Internal state tracked by the builder.
 * @internal
 */
export interface BuilderState {
  options?: ServerOptions | undefined;
  toolProviders: ToolProvider[];
  tools: ToolDefinition[];
  resourceProviders: ResourceProvider[];
  resources: ResourceStaticDefinition[];
  resourceTemplates: ResourceTemplateDefinition[];
  promptProviders: PromptProvider[];
  prompts: PromptDefinition[];
  taskToolProviders: TaskToolProvider[];
  taskTools: TaskToolDefinition[];
}

/**
 * Creates a fresh builder state.
 */
export function createBuilderState(): BuilderState {
  return {
    options: undefined,
    toolProviders: [],
    tools: [],
    resourceProviders: [],
    resources: [],
    resourceTemplates: [],
    promptProviders: [],
    prompts: [],
    taskToolProviders: [],
    taskTools: [],
  };
}

// ============================================================================
// Collected Primitives (output of primitive-collector)
// ============================================================================

/**
 * Result of collecting primitives from the builder state.
 *
 * All arrays are frozen (immutable) after collection.
 * Used as input for the session factory.
 */
export interface CollectedPrimitives {
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly resources: ReadonlyArray<ResourceStaticDefinition>;
  readonly resourceTemplates: ReadonlyArray<ResourceTemplateDefinition>;
  readonly prompts: ReadonlyArray<PromptDefinition>;
  readonly taskTools: ReadonlyArray<TaskToolDefinition>;
}
