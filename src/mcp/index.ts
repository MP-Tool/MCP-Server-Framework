/**
 * MCP Module
 *
 * Central export point for all MCP protocol-related functionality.
 * This module provides the building blocks for defining and managing
 * MCP tools, resources, prompts, and protocol handlers.
 *
 * ## Module Structure
 *
 * - **types/** — Consolidated type definitions
 * - **capabilities/** — Tool, resource, prompt definition factories
 * - **capabilities/registry/** — Global registries for auto-registration
 * - **responses/** — Response helper functions
 * - **handlers/** — MCP protocol handler setup (ping, progress)
 *
 * @module mcp
 */

// ============================================================================
// Types (centralized)
// ============================================================================

export type {
  // Response types
  ContentAudience,
  ContentAnnotations,
  ResponseOptions,
  TextResponseOptions,
  JsonResponseOptions,
  ErrorResponseOptions,
  ImageMimeType,
  ImageResponseOptions,
  AudioMimeType,
  AudioResponseOptions,
  ToolResponse,
} from "./types/index.js";

// ============================================================================
// Define Functions (Zero-Boilerplate Registration)
// ============================================================================

export { defineTool } from "./capabilities/tools/index.js";
export { defineResource, defineResourceTemplate } from "./capabilities/resources/index.js";
export { definePrompt } from "./capabilities/prompts/index.js";
export { defineApp } from "./capabilities/apps/index.js";
export { defineTask } from "./capabilities/tasks/index.js";

// ============================================================================
// Response Helpers
// ============================================================================

export { text, json, error, image, audio, multi } from "./responses/index.js";

// ============================================================================
// Registries
// ============================================================================

// Per-tool-call context accessor (AsyncLocalStorage-backed)
export { getCurrentToolContext } from "./current-tool-context.js";

// User confirmation via MCP Elicitation
export { elicitConfirmation } from "./elicit-confirmation.js";
export type { ElicitConfirmationOptions, ElicitConfirmationOutcome } from "./elicit-confirmation.js";

export {
  BaseRegistry,
  ToolRegistry,
  globalToolRegistry,
  ResourceRegistry,
  globalResourceRegistry,
  PromptRegistry,
  globalPromptRegistry,
  TaskToolRegistry,
  globalTaskToolRegistry,
  resetAllRegistries,
} from "./capabilities/registry/index.js";

export type { RegistryItem, TaskToolBindOptions } from "./capabilities/registry/index.js";

// Provider interfaces (for McpServerBuilder consumers)
export type { ToolProvider, ResourceProvider, PromptProvider, TaskToolProvider } from "./types/index.js";
