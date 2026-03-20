/**
 * Registry Reset Utility
 *
 * Provides a lifecycle function to reset all global registries.
 * Keeps the barrel file (index.ts) free of implementation logic.
 *
 * @module mcp/capabilities/registry/reset
 */

import { logger as baseLogger } from "../../../logger/index.js";
import { globalToolRegistry } from "./tool-registry.js";
import { globalResourceRegistry } from "./resource-registry.js";
import { globalPromptRegistry } from "./prompt-registry.js";
import { globalTaskToolRegistry } from "./task-tool-registry.js";

// ============================================================================
// Logger
// ============================================================================

const logger = baseLogger.child({ component: "registry" });

// ============================================================================
// Lifecycle Utilities
// ============================================================================

/**
 * Reset all global registries.
 *
 * Clears all registered tools, resources, resource templates, and prompts
 * from the global singleton registries. After calling this, all `define*()`
 * calls must be re-executed to repopulate the registries.
 *
 * **Use cases:**
 * - Hot-reload during development
 * - Server restart / lifecycle management
 * - Isolated testing scenarios
 *
 * @example
 * ```typescript
 * import { resetAllRegistries } from 'mcp-server-framework';
 *
 * // Before re-registering tools in a hot-reload scenario
 * resetAllRegistries();
 * ```
 */
export function resetAllRegistries(): void {
  globalToolRegistry.clear();
  globalResourceRegistry.clear();
  globalPromptRegistry.clear();
  globalTaskToolRegistry.clear();
  logger.debug("All registries reset");
}
