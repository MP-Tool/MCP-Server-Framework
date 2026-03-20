/**
 * Server Builder Constants
 *
 * Constants and default values for the server builder.
 *
 * @module server/builder/constants
 */

// ============================================================================
// Builder Constants
// ============================================================================

/**
 * Default server name when not specified.
 */
export const DEFAULT_SERVER_NAME = "mcp-server";

/**
 * Default server version when not specified.
 */
export const DEFAULT_SERVER_VERSION = "1.0.0";

/**
 * Log component name for builder operations.
 */
export const BUILDER_LOG_COMPONENT = "server-builder";

// ============================================================================
// Builder Error Messages
// ============================================================================

/**
 * Builder-specific error messages.
 */
export const BuilderMessages = {
  OPTIONS_REQUIRED: "Server options are required. Call withOptions() before build().",
  OPTIONS_ALREADY_SET: "Server options have already been configured.",
  NAME_REQUIRED: "Server name is required in options.",
  VERSION_REQUIRED: "Server version is required in options.",
  ALREADY_BUILT: "This builder has already been used to build a server. Create a new McpServerBuilder instance.",
} as const;

// ============================================================================
// Builder Log Messages
// ============================================================================

/**
 * Log messages for builder operations.
 */
export const BuilderLogMessages = {
  OPTIONS_CONFIGURED: "Server options configured: name=%s, version=%s",
  BUILD_STARTED: "Building server instance...",
  BUILD_COMPLETED: "Server instance built successfully",
  BUILD_SUMMARY: "Server ready: %d tools, %d resources, %d prompts",
  DUPLICATE_TOOL: "Duplicate tool name detected: %s — last registration wins",
  DUPLICATE_RESOURCE: "Duplicate resource URI detected: %s — last registration wins",
  DUPLICATE_TEMPLATE: "Duplicate resource template detected: %s — last registration wins",
  DUPLICATE_PROMPT: "Duplicate prompt name detected: %s — last registration wins",
  DUPLICATE_TASK_TOOL: "Duplicate task tool name detected: %s — last registration wins",
  NO_CAPABILITIES: "Server built with no tools, resources, or prompts registered",
} as const;
