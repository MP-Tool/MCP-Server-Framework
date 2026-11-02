/**
 * Primitive Collector
 *
 * Collects tools, resources, resource templates, and prompts from
 * providers and direct registrations. Rejects duplicates and returns
 * frozen, immutable arrays.
 *
 * Extracted from McpServerBuilder.build() for single responsibility.
 *
 * @module server/builder/primitive-collector
 */

import type { BuilderState, CollectedPrimitives } from "./types.js";
import { BuilderLogMessages, BUILDER_LOG_COMPONENT } from "./constants.js";
import { ConfigurationError } from "../../errors/categories/validation.js";
import { logger as frameworkLogger } from "../../logger/index.js";

const logger = frameworkLogger.child({ component: BUILDER_LOG_COMPONENT });

// ============================================================================
// Collection
// ============================================================================

/**
 * Collects all MCP primitives from builder state.
 *
 * Merges directly registered items with items from providers,
 * rejects duplicates, and freezes all arrays for immutability after build.
 *
 * @param state - Current builder state with providers and direct registrations
 * @returns Frozen, immutable primitive arrays
 * @throws {ConfigurationError} When two primitives share an identifier
 */
export function collectPrimitives(state: BuilderState): CollectedPrimitives {
  const tools = collectItems(state.tools, state.toolProviders, (p) => p.getTools());
  const resources = collectItems(state.resources, state.resourceProviders, (p) => p.getResources());
  const resourceTemplates = collectItems(state.resourceTemplates, state.resourceProviders, (p) => p.getTemplates());
  const prompts = collectItems(state.prompts, state.promptProviders, (p) => p.getPrompts());
  const taskTools = collectItems(state.taskTools, state.taskToolProviders, (p) => p.getTaskTools());

  // The SDK keeps tools and task tools in one namespace and registers a template under its name,
  // while clients address it by its URI template. It throws on some duplicates only when a session
  // is created, which passes `build()` and `/ready` and then fails every `initialize`, and on others
  // silently keeps the last definition. Either way the server is wrong from the start.
  const duplicates = [
    ...findDuplicates(
      "tool or task tool",
      [...tools, ...taskTools].map((t) => t.name),
    ),
    ...findDuplicates(
      "resource URI",
      resources.map((r) => r.uri),
    ),
    ...findDuplicates(
      "resource template",
      resourceTemplates.map((t) => t.uriTemplate),
    ),
    ...findDuplicates(
      "resource template name",
      resourceTemplates.map((t) => t.name),
    ),
    ...findDuplicates(
      "prompt",
      prompts.map((p) => p.name),
    ),
  ];
  if (duplicates.length > 0) {
    throw ConfigurationError.invalid(`duplicate registrations: ${duplicates.join(", ")}`);
  }

  if (
    tools.length === 0 &&
    resources.length === 0 &&
    resourceTemplates.length === 0 &&
    prompts.length === 0 &&
    taskTools.length === 0
  ) {
    logger.warn(BuilderLogMessages.NO_CAPABILITIES);
  }

  return {
    tools: Object.freeze(tools),
    resources: Object.freeze(resources),
    resourceTemplates: Object.freeze(resourceTemplates),
    prompts: Object.freeze(prompts),
    taskTools: Object.freeze(taskTools),
  };
}

// ============================================================================
// Generic Collection Helper
// ============================================================================

/**
 * Generic collection helper — merges direct items with provider items.
 *
 * @param direct - Directly registered items
 * @param providers - Provider instances
 * @param getFromProvider - Extracts items from a single provider
 */
function collectItems<TItem, TProvider>(
  direct: readonly TItem[],
  providers: readonly TProvider[],
  getFromProvider: (provider: TProvider) => readonly TItem[],
): TItem[] {
  const all: TItem[] = [...direct];
  for (const provider of providers) {
    all.push(...getFromProvider(provider));
  }
  return all;
}

// ============================================================================
// Duplicate Detection
// ============================================================================

/**
 * Describes each identifier that occurs more than once.
 *
 * @param label - What the identifiers name, for the message
 * @param keys - Identifiers to check
 */
function findDuplicates(label: string, keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].map((key) => `${label} "${key}"`);
}
