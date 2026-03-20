/**
 * Registry Module
 *
 * Provides registry classes that implement Provider interfaces for direct use
 * with McpServerBuilder. Each registry also provides `static bindToSdk()` for
 * registering definitions with MCP SDK server instances.
 *
 * @module mcp/capabilities/registry
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base Registry
// ─────────────────────────────────────────────────────────────────────────────

export { BaseRegistry, type RegistryItem } from "./base-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

export { ToolRegistry, globalToolRegistry, type ToolBindOptions } from "./tool-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Resource Registry
// ─────────────────────────────────────────────────────────────────────────────

export { ResourceRegistry, globalResourceRegistry, type ResourceBindOptions } from "./resource-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Registry
// ─────────────────────────────────────────────────────────────────────────────

export { PromptRegistry, globalPromptRegistry, type PromptBindOptions } from "./prompt-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

export { TaskToolRegistry, globalTaskToolRegistry, type TaskToolBindOptions } from "./task-tool-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Utilities
// ─────────────────────────────────────────────────────────────────────────────

export { resetAllRegistries } from "./reset.js";
