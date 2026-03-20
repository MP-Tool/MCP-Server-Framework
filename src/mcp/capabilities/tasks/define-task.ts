/**
 * Task Tool Definition Factory
 *
 * Provides the defineTask() factory function for defining MCP task tools.
 * Task tools enable long-running, asynchronous tool execution with a
 * create → poll → result lifecycle.
 *
 * Tools defined with this function are automatically registered in the
 * global task tool registry and discovered by `createServer()`.
 *
 * @experimental MCP Tasks is an experimental SDK feature
 * @module mcp/capabilities/tasks/define-task
 */

import type { z } from "zod";

import type { TaskToolDefinition } from "../../types/index.js";
import { globalTaskToolRegistry } from "../registry/index.js";
import {
  validateDefinitionBase,
  validateFunction,
  validateZodSchema,
  validateObject,
  validateEnum,
} from "../../../utils/index.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a task tool with automatic registration.
 *
 * Task tools support long-running operations via the MCP Tasks protocol.
 * Instead of blocking until completion, the client receives a task ID and
 * can poll for status updates and results.
 *
 * The tool is automatically registered in the global task tool registry.
 * The framework uses the SDK's `experimental.tasks.registerToolTask()` internally.
 *
 * @typeParam TInput - Zod schema type (inferred)
 *
 * @param definition - Task tool definition with name, description, input schema, and task handler
 * @returns The registered task tool definition (for re-export and type inference)
 *
 * @experimental MCP Tasks is an experimental SDK feature
 *
 * @example
 * ```typescript
 * import { defineTask, text, z } from 'mcp-server-framework';
 *
 * export const longComputation = defineTask({
 *   name: 'long_computation',
 *   description: 'Perform a long-running computation',
 *   input: z.object({ data: z.string() }),
 *   taskSupport: 'required',
 *   taskHandler: {
 *     createTask: async (args, ctx) => {
 *       const task = await ctx.taskStore.createTask({ ttl: 300_000 });
 *       startBackgroundWork(task.taskId, args);
 *       return { task };
 *     },
 *     getTask: async (_args, ctx) => ctx.taskStore.getTask(ctx.taskId),
 *     getTaskResult: async (_args, ctx) => ctx.taskStore.getTaskResult(ctx.taskId),
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Optional task support — tool can be called normally OR as a task
 * export const flexibleTool = defineTask({
 *   name: 'flexible_process',
 *   description: 'Process that supports both sync and async execution',
 *   input: z.object({ items: z.array(z.string()) }),
 *   taskSupport: 'optional',
 *   taskHandler: {
 *     createTask: async (args, ctx) => {
 *       const task = await ctx.taskStore.createTask({});
 *       processInBackground(task.taskId, args);
 *       return { task };
 *     },
 *     getTask: async (_args, ctx) => ctx.taskStore.getTask(ctx.taskId),
 *     getTaskResult: async (_args, ctx) => ctx.taskStore.getTaskResult(ctx.taskId),
 *   },
 * });
 * ```
 */
export function defineTask<TInput extends z.ZodTypeAny>(
  definition: TaskToolDefinition<TInput>,
): TaskToolDefinition<TInput> {
  // Validate required fields
  validateDefinitionBase(definition, "TaskTool");
  validateZodSchema(definition.input, "TaskTool", "input");

  // Validate task handler object and its methods
  validateObject(definition.taskHandler, "TaskTool", "taskHandler");
  validateFunction(definition.taskHandler.createTask, "TaskTool", "taskHandler.createTask");
  validateFunction(definition.taskHandler.getTask, "TaskTool", "taskHandler.getTask");
  validateFunction(definition.taskHandler.getTaskResult, "TaskTool", "taskHandler.getTaskResult");

  // Validate taskSupport value (defaults to 'required')
  const taskSupport = definition.taskSupport ?? "required";
  validateEnum(taskSupport, ["optional", "required"], "TaskTool", "taskSupport");

  // Auto-register in global task tool registry
  globalTaskToolRegistry.registerFromFactory(definition);

  return definition;
}
