/**
 * Task Tool Registry
 *
 * Global registry for MCP task tools that implements TaskToolProvider interface.
 * Extends BaseRegistry for common CRUD operations.
 *
 * The registry is the single authority for task tool definitions:
 * - Storage: CRUD operations via BaseRegistry
 * - SDK Binding: `bindToSdk()` registers task tools with MCP SDK server instances
 *
 * @experimental MCP Tasks is an experimental SDK feature
 * @module mcp/capabilities/registry/task-tool-registry
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolTaskHandler as SdkToolTaskHandler } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";

import type { z } from "zod";

import type {
  TaskToolDefinition,
  TaskToolProvider,
  TaskCreateContext,
  TaskOperationContext,
  SendNotificationFn,
} from "../../types/index.js";
import { createProgressReporter } from "../../handlers/index.js";
import type { Logger } from "../../../logger/index.js";
import { BaseRegistry } from "./base-registry.js";

// ============================================================================
// Constants
// ============================================================================

const SdkBindingMessages = {
  TASK_TOOLS_REGISTERED: "Registered %d task tools with SDK",
  TASK_TOOL_REGISTERED: "Registered task tool: %s (taskSupport=%s)",
  NO_TASK_TOOLS: "No task tools to register",
} as const;

// ============================================================================
// SDK Binding Options
// ============================================================================

/**
 * Options for binding task tools to an MCP SDK server.
 * @internal
 */
export interface TaskToolBindOptions {
  readonly logger: Logger;
  readonly stateless: boolean;
}

// ============================================================================
// SDK Extra Interface
// ============================================================================

/**
 * SDK extra shape shared by all three task handler methods.
 * @internal
 */
interface SdkTaskExtra {
  readonly signal: AbortSignal;
  readonly requestId: string | number;
  readonly sessionId?: string | undefined;
  readonly _meta?: { progressToken?: string | number | undefined } | undefined;
  readonly sendNotification: SendNotificationFn;
  readonly taskId?: string | undefined;
  readonly taskStore?: unknown | undefined;
}

// ============================================================================
// Task Tool Registry Class
// ============================================================================

/**
 * Registry for MCP task tools that implements TaskToolProvider.
 *
 * Extends BaseRegistry for standard CRUD operations (register, get, has, etc.)
 * and provides `bindToSdk()` for registering task tools with MCP SDK server instances.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * import { globalTaskToolRegistry, defineTask } from 'mcp-server-framework';
 *
 * // Task tools are auto-registered via defineTask()
 * defineTask({ name: 'long_job', ... });
 *
 * // Registry can be used directly as a provider
 * builder.withTaskToolProvider(globalTaskToolRegistry);
 * ```
 */
export class TaskToolRegistry extends BaseRegistry<TaskToolDefinition> implements TaskToolProvider {
  // ──────────────────────────────────────────────────────────────────────────
  // Factory
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Creates an isolated TaskToolRegistry (no shared global state).
   *
   * Used for testing.
   */
  static createIsolated(): TaskToolRegistry {
    return new TaskToolRegistry();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BaseRegistry Override
  // ──────────────────────────────────────────────────────────────────────────

  protected override get itemTypeName(): string {
    return "TaskTool";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Generic Registration (Variance-Safe)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a task tool from a generic factory function.
   *
   * Centralizes TypeScript generic variance handling. See ToolRegistry for
   * detailed explanation of the variance pattern.
   *
   * @internal Used by defineTask() — prefer registerOrReplace() for non-generic usage.
   */
  registerFromFactory<TInput extends z.ZodTypeAny>(taskTool: TaskToolDefinition<TInput>): boolean {
    // @type-variance — Generic input erased for homogeneous storage; SDK validates at runtime
    return this.registerOrReplace(taskTool as unknown as TaskToolDefinition);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TaskToolProvider Implementation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get all registered task tools.
   *
   * @returns Readonly array of all task tools
   */
  getTaskTools(): ReadonlyArray<TaskToolDefinition> {
    return this.getAll();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SDK Binding
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Registers task tools with the MCP SDK's experimental tasks API.
   *
   * Each task tool is registered via `sdk.experimental.tasks.registerToolTask()`.
   * The SDK handles the task lifecycle protocol (`tasks/list`, `tasks/get`,
   * `tasks/result`, `tasks/cancel`) automatically when a `taskStore` is provided.
   *
   * @param sdk - The MCP SDK server instance
   * @param taskTools - Task tool definitions to register
   * @param options - Registration context (logger, stateless mode)
   * @internal
   * @experimental
   */
  static bindToSdk(sdk: McpServer, taskTools: readonly TaskToolDefinition[], options: TaskToolBindOptions): void {
    const { logger, stateless } = options;

    if (taskTools.length === 0) {
      logger.trace(SdkBindingMessages.NO_TASK_TOOLS);
      return;
    }

    logger.trace(SdkBindingMessages.TASK_TOOLS_REGISTERED, taskTools.length);

    for (const taskTool of taskTools) {
      const taskSupport = taskTool.taskSupport ?? "required";

      // @sdk-constraint — SDK registerToolTask has two overloads:
      // Overload 1 (no input): config without inputSchema, ToolTaskHandler<undefined>
      // Overload 2 (with input): config with inputSchema, ToolTaskHandler<InputArgs>
      // We must cast to AnySchema to select overload 2
      const sdkHandler: SdkToolTaskHandler<AnySchema> = {
        createTask: async (args: unknown, extra) => {
          const base = TaskToolRegistry.buildBaseContext(extra, stateless);
          const context: TaskCreateContext = {
            ...base,
            taskStore: extra.taskStore,
          };

          // @sdk-constraint — SDK registerToolTask erases input schema type; args validated at runtime
          return taskTool.taskHandler.createTask(
            args as Parameters<typeof taskTool.taskHandler.createTask>[0],
            context,
          );
        },

        getTask: async (args: unknown, extra) => {
          const base = TaskToolRegistry.buildBaseContext(extra, stateless);
          const context: TaskOperationContext = {
            ...base,
            taskId: extra.taskId,
            taskStore: extra.taskStore,
          };

          // @sdk-constraint — SDK registerToolTask erases input schema type; args validated at runtime
          return taskTool.taskHandler.getTask(args as Parameters<typeof taskTool.taskHandler.getTask>[0], context);
        },

        getTaskResult: async (args: unknown, extra) => {
          const base = TaskToolRegistry.buildBaseContext(extra, stateless);
          const context: TaskOperationContext = {
            ...base,
            taskId: extra.taskId,
            taskStore: extra.taskStore,
          };

          // @sdk-constraint — SDK registerToolTask erases input schema type; args validated at runtime
          return taskTool.taskHandler.getTaskResult(
            args as Parameters<typeof taskTool.taskHandler.getTaskResult>[0],
            context,
          );
        },
      };

      sdk.experimental.tasks.registerToolTask(
        taskTool.name,
        {
          description: taskTool.description,
          // @sdk-constraint — registerToolTask expects AnySchema; Zod input is compatible at runtime
          inputSchema: taskTool.input as AnySchema,
          execution: { taskSupport },
          ...(taskTool.annotations && { annotations: taskTool.annotations }),
          ...(taskTool._meta && { _meta: taskTool._meta }),
        },
        sdkHandler,
      );

      logger.trace(SdkBindingMessages.TASK_TOOL_REGISTERED, taskTool.name, taskSupport);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private SDK Binding Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Builds the shared base context from SDK extra parameters.
   * Common to all three task handler methods.
   */
  private static buildBaseContext(
    extra: SdkTaskExtra,
    stateless: boolean,
  ): {
    reportProgress: TaskCreateContext["reportProgress"];
    abortSignal: AbortSignal;
    requestId: string | number;
    sessionId?: string | undefined;
    stateless: boolean;
  } {
    const progressToken = extra._meta?.progressToken;
    const reportProgress = createProgressReporter(extra.sendNotification.bind(extra), progressToken);

    return {
      reportProgress,
      abortSignal: extra.signal,
      requestId: extra.requestId,
      sessionId: extra.sessionId,
      stateless,
    };
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global task tool registry singleton.
 *
 * This instance is used by defineTask() for auto-registration
 * and by createServer() to discover all task tools.
 */
export const globalTaskToolRegistry = new TaskToolRegistry();
