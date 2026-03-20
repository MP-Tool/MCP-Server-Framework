/**
 * Tool Definition Factory
 *
 * Provides the defineTool() factory function for zero-boilerplate tool registration.
 * Tools defined with this function are automatically registered in a global registry.
 *
 * @module mcp/capabilities/tools/define-tool
 */

import type { z } from "zod";

import type { ToolDefinition } from "../../types/index.js";
import { globalToolRegistry } from "../registry/index.js";
import { validateDefinitionBase, validateFunction, validateZodSchema } from "../../../utils/index.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a tool with automatic registration.
 *
 * This is the recommended way to define tools in the framework.
 * The tool is automatically registered in the global registry when defined.
 *
 * @typeParam TInput - Zod schema type (inferred)
 *
 * @param definition - Tool definition with name, description, input schema, and handler
 * @returns The registered tool definition (for re-export and type inference)
 *
 * **Important**: Call `defineTool()` at module scope (top-level). The tool is
 * registered as a side-effect of module import. For conditional or runtime
 * tool management, use `McpServerBuilder` with a custom `ToolProvider`.
 *
 * @example
 * ```typescript
 * // tools/greet.ts
 * import { defineTool, text } from 'mcp-server-framework';
 * import { z } from 'zod';
 *
 * export const greetTool = defineTool({
 *   name: 'greet',
 *   description: 'Greet a user by name',
 *   input: z.object({
 *     name: z.string().describe('The name to greet'),
 *   }),
 *   handler: async ({ name }) => text(`Hello, ${name}!`),
 * });
 * ```
 *
 * @example
 * ```typescript
 * // tools/items.ts - With annotations and external API client
 * import { defineTool, json } from 'mcp-server-framework';
 * import { z } from 'zod';
 * import { apiClient } from '../api/client.js';
 *
 * export const listItems = defineTool({
 *   name: 'list_items',
 *   description: 'List all items',
 *   input: z.object({ category: z.string() }),
 *   annotations: { readOnlyHint: true, openWorldHint: true },
 *   handler: async ({ category }) => {
 *     const items = await apiClient.items.list(category);
 *     return json(items);
 *   },
 * });
 * ```
 */
export function defineTool<TInput extends z.ZodTypeAny>(definition: ToolDefinition<TInput>): ToolDefinition<TInput> {
  // Validate required fields (safety net for JS consumers and empty strings)
  validateDefinitionBase(definition, "Tool");
  validateZodSchema(definition.input, "Tool", "input");
  validateFunction(definition.handler, "Tool", "handler");

  // Auto-register in global registry (variance handled by registry)
  globalToolRegistry.registerFromFactory(definition);

  return definition;
}
