/**
 * Server Builder Module
 *
 * Provides a fluent, declarative API for constructing MCP servers.
 * This module is the primary entry point for creating servers with the framework.
 *
 * @module server/builder
 *
 * @example Basic usage
 * ```typescript
 * import { McpServerBuilder } from './server/builder/index.js';
 *
 * const server = new McpServerBuilder<MyClient>()
 *   .withOptions({ name: 'my-server', version: '1.0.0' })
 *   .withToolProvider(toolRegistry)
 *   .build();
 *
 * await server.start();
 * ```
 */

// Main builder class
export { McpServerBuilder } from "./server-builder.js";

// Constants
export { DEFAULT_SERVER_NAME, DEFAULT_SERVER_VERSION } from "./constants.js";

// Types (builder-specific only — BuilderState is @internal, not exported)
export type { ServerBuilder } from "./types.js";
