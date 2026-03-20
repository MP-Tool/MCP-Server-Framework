/**
 * MCP Registration Module
 *
 * Provides the capabilities builder for the MCP SDK.
 * Tool/resource/prompt registration is handled directly by McpSession.
 *
 * ## Architecture
 *
 * ```
 * Registry (stores definitions) → McpSession (registers with SDK) → SDK (protocol server)
 * ```
 *
 * @module mcp/capabilities
 */

// ============================================================================
// Capabilities
// ============================================================================

export { buildCapabilities } from "./capabilities.js";
export { type ServerCapabilities, DEFAULT_CAPABILITIES } from "./server-capabilities.js";
