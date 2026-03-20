/**
 * MCP Capabilities Builder
 *
 * Builds MCP capabilities objects based on registered primitives.
 * The capabilities object tells the SDK which features the server supports.
 *
 * @module mcp/capabilities
 */

import type {
  ToolDefinition,
  TaskToolDefinition,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  PromptDefinition,
} from "../types/index.js";
import { DEFAULT_CAPABILITIES, type ServerCapabilities } from "./server-capabilities.js";

// ============================================================================
// Capabilities Builder
// ============================================================================

/**
 * Builds the MCP capabilities object based on registered primitives.
 *
 * @internal Used by server runtime during SDK initialization.
 * @param capabilities - Configured server capabilities
 * @param tools - All available tool definitions
 * @param resources - Static resource definitions
 * @param resourceTemplates - Resource template definitions
 * @param prompts - Prompt definitions
 * @param taskTools - Task tool definitions (experimental)
 * @returns Capabilities object for the MCP SDK
 */
export function buildCapabilities(
  capabilities: ServerCapabilities | undefined,
  tools: readonly ToolDefinition[],
  resources: readonly ResourceStaticDefinition[],
  resourceTemplates: readonly ResourceTemplateDefinition[],
  prompts: readonly PromptDefinition[],
  taskTools: readonly TaskToolDefinition[] = [],
): Record<string, unknown> {
  const caps = capabilities ?? DEFAULT_CAPABILITIES;
  const result: Record<string, unknown> = {};

  // Logging capability
  if (caps.logging) {
    result.logging = {};
  }

  // Tools capability
  if (caps.tools && tools.length > 0) {
    result.tools = typeof caps.tools === "object" ? caps.tools : { listChanged: true };
  }

  // Resources capability
  if (caps.resources && (resources.length > 0 || resourceTemplates.length > 0)) {
    result.resources = typeof caps.resources === "object" ? caps.resources : { listChanged: true };
  }

  // Prompts capability
  if (caps.prompts && prompts.length > 0) {
    result.prompts = typeof caps.prompts === "object" ? caps.prompts : { listChanged: true };
  }

  // Tasks capability (experimental) — required by SDK assertRequestHandlerCapability
  if (taskTools.length > 0) {
    result.tasks = { requests: { tools: { call: {} } } };
  }

  return result;
}
