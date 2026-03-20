/**
 * Prompt Definition Factory
 *
 * Provides the definePrompt() factory function for zero-boilerplate prompt registration.
 * Prompts defined with this function are automatically registered in a global registry.
 *
 * @module mcp/capabilities/prompts/define-prompt
 */

import type { z } from "zod";
import type { PromptDefinition } from "../../types/index.js";
import { globalPromptRegistry } from "../registry/index.js";
import { validateDefinitionBase, validateFunction, validateZodSchema } from "../../../utils/index.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define a prompt with automatic registration.
 *
 * This is the recommended way to define prompts in the framework.
 * The prompt is automatically registered in the global registry when defined.
 *
 * @typeParam TInput - Zod object schema for input validation
 * @param definition - Prompt definition with name, description, optional input schema, and generate handler
 * @returns The prompt definition (for re-export and type inference)
 *
 * @example
 * ```typescript
 * // prompts/explain.ts - Prompt with typed arguments
 * import { definePrompt } from 'mcp-server-framework';
 * import { z } from 'zod';
 *
 * export const explainPrompt = definePrompt({
 *   name: 'explain-concept',
 *   description: 'Explain a technical concept clearly',
 *   input: z.object({
 *     topic: z.string().describe('The topic to explain'),
 *     level: z.enum(['beginner', 'intermediate', 'expert'])
 *       .default('intermediate')
 *       .describe('Target expertise level'),
 *   }),
 *   generate: async ({ topic, level }) => [
 *     {
 *       role: 'user',
 *       content: `Please explain ${topic} for someone at ${level} level.
 *
 * Include:
 * - A clear definition
 * - Key concepts
 * - Practical examples
 * - Common misconceptions`,
 *     },
 *   ],
 * });
 * ```
 *
 * @example
 * ```typescript
 * // prompts/code-review.ts - Multi-turn prompt
 * import { definePrompt } from 'mcp-server-framework';
 * import { z } from 'zod';
 *
 * export const codeReviewPrompt = definePrompt({
 *   name: 'code-review',
 *   description: 'Start a code review conversation',
 *   input: z.object({
 *     code: z.string().describe('The code to review'),
 *     language: z.string().describe('Programming language'),
 *   }),
 *   generate: async ({ code, language }) => [
 *     {
 *       role: 'user',
 *       content: `Please review this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
 *     },
 *     {
 *       role: 'assistant',
 *       content: 'I\'ll analyze this code for best practices, potential bugs, and improvements.',
 *     },
 *   ],
 * });
 * ```
 *
 * @example
 * ```typescript
 * // prompts/greeting.ts - No-argument prompt
 * import { definePrompt } from 'mcp-server-framework';
 *
 * export const greetingPrompt = definePrompt({
 *   name: 'greeting',
 *   description: 'Standard greeting prompt',
 *   generate: async () => [
 *     {
 *       role: 'user',
 *       content: 'Hello! How can you help me today?',
 *     },
 *   ],
 * });
 * ```
 */
export function definePrompt<TInput extends z.AnyZodObject = z.AnyZodObject>(
  definition: PromptDefinition<TInput>,
): PromptDefinition<TInput> {
  // Validate required fields (safety net for JS consumers and empty strings)
  validateDefinitionBase(definition, "Prompt");
  validateFunction(definition.generate, "Prompt", "generate");

  // Validate optional Zod schema if provided (consistent with defineTool)
  if (definition.input) {
    validateZodSchema(definition.input, "Prompt", "input");
  }

  // Auto-register in global registry (variance handled by registry)
  globalPromptRegistry.registerFromFactory(definition);

  return definition;
}
