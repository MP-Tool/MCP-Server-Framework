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

export { type RegistryItem } from "./base-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

export { ToolRegistry, globalToolRegistry } from "./tool-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tool-Result Secret Scrubbing (central redaction boundary)
// ─────────────────────────────────────────────────────────────────────────────

export { createResultScrubber, type ScrubToolResultsConfig } from "./result-scrub.js";
export { resolveScrubConfig } from "./resolve-scrub-config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Resource Registry
// ─────────────────────────────────────────────────────────────────────────────

export { ResourceRegistry, globalResourceRegistry } from "./resource-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Registry
// ─────────────────────────────────────────────────────────────────────────────

export { PromptRegistry, globalPromptRegistry } from "./prompt-registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Task Tool Registry
// ─────────────────────────────────────────────────────────────────────────────

export { TaskToolRegistry, globalTaskToolRegistry } from "./task-tool-registry.js";
