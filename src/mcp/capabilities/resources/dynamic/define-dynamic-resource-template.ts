/**
 * Dynamic Resource Template
 *
 * Convenience factory that registers the single MCP resource template used to
 * serve entries stored in the {@link DynamicResourceRegistry}. Tools that store
 * payloads in the registry only return the generated `ephemeral://…` URI; the
 * client follows up with a `resources/read` request, which the SDK routes to
 * this template.
 *
 * @module mcp/capabilities/resources/dynamic/define-dynamic-resource-template
 */

import { z } from "zod";

import type { ResourceTemplateDefinition } from "../../../types/index.js";
import { defineResourceTemplate } from "../define-resource.js";
import { getDynamicResourceRegistry, type DynamicResourceRegistry } from "./dynamic-resource-registry.js";

const DEFAULT_TEMPLATE_NAME = "ephemeral-resource";
const DEFAULT_TEMPLATE_DESCRIPTION =
  "Ephemeral, session-bound payload registered at runtime by tools (logs, inspect output, large dumps).";

/**
 * Options for {@link defineDynamicResourceTemplate}.
 */
export interface DefineDynamicResourceTemplateOptions {
  /** Override the registry to bind the template to (defaults to the global singleton) */
  readonly registry?: DynamicResourceRegistry;
  /** Override the resource template name (default: `ephemeral-resource`) */
  readonly name?: string;
  /** Override the template description shown to clients */
  readonly description?: string;
}

const dynamicTemplateInput = z.object({
  category: z.string().min(1).describe("Resource category (URI segment)"),
  id: z.string().min(1).describe("Generated entry id (32-hex-char)"),
});

/**
 * Registers (and returns) the resource template that serves all entries from
 * the dynamic resource registry. Strict session-binding is enforced inside the
 * registry — cross-session reads throw a 403.
 *
 * Call this once during server startup, after the registry has been configured.
 *
 * @example
 * ```typescript
 * import {
 *   configureDynamicResourceRegistry,
 *   defineDynamicResourceTemplate,
 * } from 'mcp-server-framework';
 *
 * configureDynamicResourceRegistry({ defaultTtlMs: 120_000, maxEntries: 500 });
 * defineDynamicResourceTemplate();
 * ```
 */
export function defineDynamicResourceTemplate(
  options?: DefineDynamicResourceTemplateOptions,
): ResourceTemplateDefinition<typeof dynamicTemplateInput> {
  const registry = options?.registry ?? getDynamicResourceRegistry();
  const scheme = registry.uriScheme;

  return defineResourceTemplate({
    name: options?.name ?? DEFAULT_TEMPLATE_NAME,
    description: options?.description ?? DEFAULT_TEMPLATE_DESCRIPTION,
    uriTemplate: `${scheme}://{category}/{id}`,
    input: dynamicTemplateInput,
    read: async (params, ctx) => {
      const uri = `${scheme}://${params.category}/${params.id}`;
      const result = registry.read(uri, ctx?.sessionId);
      return { content: result.content, mimeType: result.mimeType };
    },
  });
}
