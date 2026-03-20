/**
 * MCP Types Module
 *
 * Central export point for all MCP-related type definitions.
 * This is the SINGLE SOURCE OF TRUTH for MCP types in the framework.
 *
 * ## Type Categories
 *
 * - **Definition Types** — Tool, Resource, Prompt definitions and providers
 * - **Handler Types** — Protocol handler interfaces and configs
 * - **Response Types** — Response helper options and content types
 * - **Context Types** — Tool execution context and progress reporting
 *
 * @module mcp/types
 */

// ============================================================================
// Definition Types (Tool, Resource, Prompt)
// ============================================================================

export type {
  // Completion types
  CompletionResult,
  CompletionCallback,
  // Tool types
  ToolAnnotations,
  ToolDefinition,
  ToolProvider,
  // Resource types
  BaseResourceDefinition,
  ResourceStaticDefinition,
  ResourceTemplateDefinition,
  ResourceDefinition,
  TextResourceContent,
  BlobResourceContent,
  ResourceContent,
  ResourceProvider,
  // Prompt types
  PromptRole,
  PromptMessage,
  PromptDefinition,
  PromptProvider,
  // App types
  AppResourceDefinition,
  AppDefinition,
  // Task tool types
  TaskSupport,
  TaskToolHandler,
  TaskToolDefinition,
  TaskToolProvider,
} from "./definition.js";

// Type Guards
export { isStaticResource, isResourceTemplate } from "./definition.js";

// ============================================================================
// Tool Context Types
// ============================================================================

export type {
  ProgressData,
  ProgressReporter,
  ToolContext,
  TaskCreateContext,
  TaskOperationContext,
  SendNotificationFn,
  ProgressToken,
} from "./context.js";

// ============================================================================
// Handler Types
// ============================================================================

export type { PingHandler, HandlersConfig } from "./handler.js";

// ============================================================================
// Response Types
// ============================================================================

export type {
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
} from "./response.js";
