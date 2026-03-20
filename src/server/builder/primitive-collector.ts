/**
 * Primitive Collector
 *
 * Collects tools, resources, resource templates, and prompts from
 * providers and direct registrations. Detects duplicates with warnings
 * and returns frozen, immutable arrays.
 *
 * Extracted from McpServerBuilder.build() for single responsibility.
 *
 * @module server/builder/primitive-collector
 */

import type { BuilderState, CollectedPrimitives } from "./types.js";
import { BuilderLogMessages, BUILDER_LOG_COMPONENT } from "./constants.js";
import { logger as frameworkLogger } from "../../logger/index.js";

const logger = frameworkLogger.child({ component: BUILDER_LOG_COMPONENT });

// ============================================================================
// Collection
// ============================================================================

/**
 * Collects all MCP primitives from builder state.
 *
 * Merges directly registered items with items from providers,
 * warns about duplicates (last registration wins), and
 * freezes all arrays for immutability after build.
 *
 * @param state - Current builder state with providers and direct registrations
 * @returns Frozen, immutable primitive arrays
 */
export function collectPrimitives(state: BuilderState): CollectedPrimitives {
  const tools = collectItems(
    state.tools,
    state.toolProviders,
    (p) => p.getTools(),
    (t) => t.name,
    BuilderLogMessages.DUPLICATE_TOOL,
  );
  const resources = collectItems(
    state.resources,
    state.resourceProviders,
    (p) => p.getResources(),
    (r) => r.uri,
    BuilderLogMessages.DUPLICATE_RESOURCE,
  );
  const resourceTemplates = collectItems(
    state.resourceTemplates,
    state.resourceProviders,
    (p) => p.getTemplates(),
    (t) => t.uriTemplate,
    BuilderLogMessages.DUPLICATE_TEMPLATE,
  );
  const prompts = collectItems(
    state.prompts,
    state.promptProviders,
    (p) => p.getPrompts(),
    (p) => p.name,
    BuilderLogMessages.DUPLICATE_PROMPT,
  );
  const taskTools = collectItems(
    state.taskTools,
    state.taskToolProviders,
    (p) => p.getTaskTools(),
    (t) => t.name,
    BuilderLogMessages.DUPLICATE_TASK_TOOL,
  );

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
 * Generic collection helper — merges direct items with provider items and warns about duplicates.
 *
 * @param direct - Directly registered items
 * @param providers - Provider instances
 * @param getFromProvider - Extracts items from a single provider
 * @param getKey - Extracts the unique identifier from each item
 * @param duplicateMessage - Printf-style log message for duplicates
 */
function collectItems<TItem, TProvider>(
  direct: readonly TItem[],
  providers: readonly TProvider[],
  getFromProvider: (provider: TProvider) => readonly TItem[],
  getKey: (item: TItem) => string,
  duplicateMessage: string,
): TItem[] {
  const all: TItem[] = [...direct];
  for (const provider of providers) {
    all.push(...getFromProvider(provider));
  }
  warnDuplicates(all, getKey, duplicateMessage);
  return all;
}

// ============================================================================
// Duplicate Detection
// ============================================================================

/**
 * Warns about duplicate identifiers in a collection.
 *
 * @param items - Collection to check
 * @param getKey - Extracts the unique identifier from each item
 * @param message - Printf-style log message with %s placeholder for the key
 */
function warnDuplicates<T>(items: T[], getKey: (item: T) => string, message: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      logger.warn(message, key);
    }
    seen.add(key);
  }
}
