/**
 * Base Registry
 *
 * Generic abstract base class for MCP registries (Tools, Resources, Prompts).
 * Extracts common functionality to reduce code duplication.
 *
 * @module mcp/capabilities/registry/base-registry
 */

import { logger as baseLogger } from "../../../logger/index.js";
import { RegistryError } from "../../../errors/index.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "registry";

const LogMessages = {
  REGISTERED: "%s registered: %s",
  REPLACED: "%s replaced: %s",
  CLEARED: "%s registry cleared (%d item(s) removed)",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Registry Item Interface
// ============================================================================

/**
 * Minimum interface for items that can be registered.
 */
export interface RegistryItem {
  readonly name: string;
}

// ============================================================================
// Base Registry Class
// ============================================================================

/**
 * Abstract base class for MCP registries.
 *
 * Provides common functionality:
 * - Registration (with duplicate checking)
 * - Lookup by name
 * - Iteration and size
 * - Clear/unregister operations
 *
 * @typeParam T - The item type (must have a `name` property)
 *
 * @example
 * ```typescript
 * class ToolRegistry extends BaseRegistry<Tool> {
 *   // Add tool-specific methods here
 * }
 * ```
 */
export abstract class BaseRegistry<T extends RegistryItem> {
  /** Internal storage */
  protected readonly items = new Map<string, T>();

  // ──────────────────────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a new item. Throws if name already exists.
   *
   * @param item - Item to register
   * @throws If an item with the same name is already registered
   */
  register(item: T): void {
    if (this.items.has(item.name)) {
      throw RegistryError.duplicate(this.itemTypeName, item.name);
    }
    this.items.set(item.name, item);
    logger.trace(LogMessages.REGISTERED, this.itemTypeName, item.name);
  }

  /**
   * Register or replace an existing item.
   *
   * @param item - Item to register/replace
   * @returns true if replaced, false if new
   */
  registerOrReplace(item: T): boolean {
    const existed = this.items.has(item.name);
    this.items.set(item.name, item);
    if (existed) {
      logger.trace(LogMessages.REPLACED, this.itemTypeName, item.name);
    } else {
      logger.trace(LogMessages.REGISTERED, this.itemTypeName, item.name);
    }
    return existed;
  }

  /**
   * Unregister an item by name.
   *
   * @param name - Name of the item to remove
   * @returns true if removed, false if not found
   */
  unregister(name: string): boolean {
    return this.items.delete(name);
  }

  /**
   * Clear all items from the registry.
   */
  clear(): void {
    const count = this.items.size;
    this.items.clear();
    if (count > 0) {
      logger.trace(LogMessages.CLEARED, this.itemTypeName, count);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lookup
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get an item by name.
   *
   * @param name - Name of the item
   * @returns The item or undefined
   */
  get(name: string): T | undefined {
    return this.items.get(name);
  }

  /**
   * Check if an item exists.
   *
   * @param name - Name to check
   * @returns true if exists
   */
  has(name: string): boolean {
    return this.items.has(name);
  }

  /**
   * Get all registered items.
   *
   * @returns Readonly array of all items
   */
  getAll(): ReadonlyArray<T> {
    return Array.from(this.items.values());
  }

  /**
   * Number of registered items.
   */
  get size(): number {
    return this.items.size;
  }

  /**
   * Iterate over all items.
   */
  [Symbol.iterator](): Iterator<T> {
    return this.items.values();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Abstract / Override
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Human-readable name for error messages (e.g., "Tool", "Resource").
   * Override in subclasses.
   */
  protected get itemTypeName(): string {
    return "Item";
  }
}
