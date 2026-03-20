/**
 * Resource Definition Factory
 *
 * Provides the defineResource() and defineResourceTemplate() factory functions
 * for zero-boilerplate resource registration. Resources defined with these
 * functions are automatically registered in global registries.
 *
 * @module mcp/capabilities/resources/define-resource
 */

import type { z } from "zod";

import type { ResourceStaticDefinition, ResourceTemplateDefinition } from "../../types/index.js";
import { globalResourceRegistry } from "../registry/index.js";
import {
  validateDefinitionBase,
  validateNonEmptyString,
  validateFunction,
  validateZodSchema,
} from "../../../utils/index.js";

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Define a resource with automatic registration.
 *
 * This is the recommended way to define static resources in the framework.
 * The resource is automatically registered in the global registry when defined.
 *
 * @param definition - Resource definition with name, description, uri, and read handler
 * @returns The registered resource (for re-export and type inference)
 *
 * @example
 * ```typescript
 * // resources/config.ts
 * import { defineResource } from 'mcp-server-framework';
 *
 * export const configResource = defineResource({
 *   name: 'app-config',
 *   description: 'Application configuration',
 *   uri: 'myapp://config/main',
 *   mimeType: 'application/json',
 *   read: async () => JSON.stringify({
 *     version: '1.0.0',
 *     environment: process.env.NODE_ENV,
 *   }),
 * });
 * ```
 *
 * @example
 * ```typescript
 * // resources/readme.ts - Text resource
 * import { defineResource } from 'mcp-server-framework';
 * import { readFile } from 'fs/promises';
 *
 * export const readmeResource = defineResource({
 *   name: 'readme',
 *   description: 'Project README file',
 *   uri: 'myapp://docs/readme',
 *   mimeType: 'text/markdown',
 *   read: async () => readFile('./README.md', 'utf-8'),
 * });
 * ```
 */
export function defineResource(definition: ResourceStaticDefinition): ResourceStaticDefinition {
  // Validate required fields (safety net for JS consumers and empty strings)
  validateDefinitionBase(definition, "Resource");
  validateNonEmptyString(definition.uri, "Resource", "uri");
  validateFunction(definition.read, "Resource", "read");

  // Auto-register in global registry (replace if exists for hot-reload support)
  globalResourceRegistry.registerOrReplaceResource(definition);

  return definition;
}

/**
 * Define a resource template with automatic registration.
 *
 * Resource templates support dynamic URIs using RFC 6570 URI Templates.
 * The template is automatically registered in the global registry when defined.
 *
 * @typeParam TInput - Zod object schema for parameter validation
 * @param definition - Template definition with name, description, uriTemplate, and read handler
 * @returns The registered template (for re-export and type inference)
 *
 * @example
 * ```typescript
 * // resources/logs.ts - With typed parameters
 * import { defineResourceTemplate } from 'mcp-server-framework';
 * import { z } from 'zod';
 *
 * export const logResource = defineResourceTemplate({
 *   name: 'log-viewer',
 *   description: 'View application logs by ID',
 *   uriTemplate: 'myapp://logs/{logId}',
 *   mimeType: 'text/plain',
 *   input: z.object({
 *     logId: z.string().describe('Log identifier'),
 *   }),
 *   read: async ({ logId }) => {
 *     const log = await fetchLogById(logId);
 *     return log.content;
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // resources/users.ts - User profile template
 * import { defineResourceTemplate } from 'mcp-server-framework';
 *
 * export const userProfileResource = defineResourceTemplate({
 *   name: 'user-profile',
 *   description: 'Get user profile by ID',
 *   uriTemplate: 'myapp://users/{userId}/profile',
 *   mimeType: 'application/json',
 *   read: async ({ userId }) => {
 *     const user = await getUserById(userId);
 *     return JSON.stringify(user);
 *   },
 * });
 * ```
 */
export function defineResourceTemplate<TInput extends z.AnyZodObject = z.AnyZodObject>(
  definition: ResourceTemplateDefinition<TInput>,
): ResourceTemplateDefinition<TInput> {
  // Validate required fields (safety net for JS consumers and empty strings)
  validateDefinitionBase(definition, "ResourceTemplate");
  validateNonEmptyString(definition.uriTemplate, "ResourceTemplate", "uriTemplate");
  validateFunction(definition.read, "ResourceTemplate", "read");

  // Basic RFC 6570 check: uriTemplate must contain at least one {varName} placeholder
  if (!/{[a-zA-Z_]\w*}/.test(definition.uriTemplate)) {
    throw new TypeError(
      `ResourceTemplate '${definition.name}': uriTemplate must contain at least one {variable} placeholder (RFC 6570), got '${definition.uriTemplate}'`,
    );
  }

  // Validate optional Zod schema if provided (consistent with defineTool)
  if (definition.input) {
    validateZodSchema(definition.input, "ResourceTemplate", "input");

    // Validate URI template variables match schema fields
    const uriVars = [...definition.uriTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
    const schemaKeys = Object.keys(definition.input.shape as Record<string, unknown>);

    const missingInSchema = uriVars.filter((v) => !schemaKeys.includes(v));
    if (missingInSchema.length > 0) {
      throw new TypeError(
        `ResourceTemplate '${definition.name}': URI template variables {${missingInSchema.join(", ")}} have no corresponding fields in the input schema`,
      );
    }
  }

  // Auto-register in global registry (variance handled by registry)
  globalResourceRegistry.registerTemplateFromFactory(definition);

  return definition;
}
