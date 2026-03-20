/**
 * MCP Server Capabilities
 *
 * Defines which MCP protocol capabilities a server advertises to clients.
 * Lives in the MCP layer because capabilities are an MCP protocol concept.
 *
 * @module mcp/capabilities/server-capabilities
 */

// ============================================================================
// Server Capabilities
// ============================================================================

/**
 * MCP server capabilities to advertise to clients.
 */
export interface ServerCapabilities {
  /** Enable tools capability with optional list-changed notifications */
  tools?: boolean | { listChanged?: boolean };

  /** Enable resources capability with optional list-changed and subscribe notifications */
  resources?: boolean | { listChanged?: boolean; subscribe?: boolean };

  /** Enable prompts capability with optional list-changed notifications */
  prompts?: boolean | { listChanged?: boolean };

  /** Enable logging capability */
  logging?: boolean;
}

/**
 * Default server capabilities.
 */
export const DEFAULT_CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: true },
  logging: true,
} as const;
