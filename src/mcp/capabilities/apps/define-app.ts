/**
 * App Definition Factory
 *
 * Provides the defineApp() factory function for defining MCP Apps.
 * An MCP App combines a tool with a UI resource, linked via
 * `_meta.ui.resourceUri` on the tool definition.
 *
 * `defineApp()` internally creates:
 * 1. A static resource via `defineResource()` (the UI)
 * 2. A tool via `defineTool()` with `_meta.ui.resourceUri` pointing to the resource
 *
 * Both are automatically registered in the global registries.
 *
 * @module mcp/capabilities/apps/define-app
 */

import type { z } from "zod";

import type { AppDefinition } from "../../types/index.js";
import { defineTool } from "../tools/index.js";
import { defineResource } from "../resources/index.js";
import { globalToolRegistry } from "../registry/index.js";
import { validateDefinitionBase, validateZodSchema, validateFunction } from "../../../utils/index.js";
import { FrameworkErrorFactory } from "../../../errors/index.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Define an MCP App with automatic resource and tool registration.
 *
 * Creates a tool linked to a UI resource via `_meta.ui.resourceUri`.
 * Both the tool and the resource are registered in the global registries,
 * so they are automatically available when `createServer()` is called.
 *
 * @typeParam TInput - Zod schema type for the tool input (inferred)
 *
 * @param definition - App definition with resource and tool configuration
 * @returns The original app definition (for re-export and type inference)
 *
 * @example
 * ```typescript
 * import { defineApp, text, z } from 'mcp-server-framework';
 *
 * export const calculator = defineApp({
 *   name: 'calculator',
 *   description: 'An interactive calculator app',
 *   resource: {
 *     uri: 'ui://calculator',
 *     mimeType: 'text/html;profile=mcp-app',
 *     read: async () => '<html>...calculator UI...</html>',
 *   },
 *   input: z.object({ expression: z.string() }),
 *   handler: async ({ expression }) => text('42'),
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With annotations and custom _meta
 * export const dashboard = defineApp({
 *   name: 'dashboard',
 *   description: 'System monitoring dashboard',
 *   resource: {
 *     uri: 'ui://dashboard',
 *     name: 'Dashboard UI',
 *     description: 'Interactive system monitoring dashboard',
 *     mimeType: 'text/html;profile=mcp-app',
 *     read: async () => generateDashboardHtml(),
 *   },
 *   input: z.object({ metric: z.string().optional() }),
 *   handler: async ({ metric }, ctx) => json(await getMetrics(metric)),
 *   annotations: { readOnlyHint: true },
 *   _meta: { version: '2.0' },
 * });
 * ```
 */
export function defineApp<TInput extends z.ZodTypeAny>(definition: AppDefinition<TInput>): AppDefinition<TInput> {
  // Validate app-level fields before delegation to defineTool/defineResource
  // This ensures error messages say "App" instead of "Tool" or "Resource"
  validateDefinitionBase(definition, "App");
  validateZodSchema(definition.input, "App", "input");
  validateFunction(definition.handler, "App", "handler");

  const { resource } = definition;

  // Validate URI scheme — MCP Inspector and clients require 'ui://' prefix
  if (!resource.uri.startsWith("ui://")) {
    throw FrameworkErrorFactory.validation.custom(
      `Invalid app resource URI "${resource.uri}" for app "${definition.name}": ` +
        `URI must use the "ui://" scheme (e.g., "ui://${definition.name}"). ` +
        `MCP clients require this prefix to identify app resources.`,
      "resource.uri",
    );
  }

  // 1. Register the tool first (more likely to fail due to schema issues)
  const toolMeta: Record<string, unknown> = {
    ...definition._meta,
    ui: {
      // @type-narrowing — _meta is Record<string, unknown>, ui may be an object or undefined
      ...(definition._meta?.ui as Record<string, unknown> | undefined),
      resourceUri: resource.uri,
    },
  };

  defineTool({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    handler: definition.handler,
    ...(definition.annotations && { annotations: definition.annotations }),
    ...(definition.requiredScopes && {
      requiredScopes: definition.requiredScopes,
    }),
    _meta: toolMeta,
  });

  // 2. Register the UI resource — rollback tool on failure
  try {
    defineResource({
      name: resource.name ?? definition.name,
      description: resource.description ?? definition.description,
      uri: resource.uri,
      mimeType: resource.mimeType ?? "text/html;profile=mcp-app",
      read: async () => resource.read(),
    });
  } catch (registrationError) {
    try {
      globalToolRegistry.unregister(definition.name);
    } catch {
      // Rollback best-effort — original registration error takes priority
    }
    throw registrationError;
  }

  return definition;
}
