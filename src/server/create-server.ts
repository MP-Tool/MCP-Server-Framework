/**
 * Create Server Function
 *
 * High-level API for creating MCP servers with minimal boilerplate.
 * Automatically uses tools, resources, and prompts from the global registries.
 *
 * @module server/create-server
 */

import { McpServerBuilder } from "./builder/index.js";
import { DEFAULT_SERVER_NAME, DEFAULT_SERVER_VERSION } from "./builder/index.js";
import { getTelemetryConfig } from "../telemetry/core/index.js";
import { logger as baseLogger } from "../logger/index.js";

import {
  globalToolRegistry,
  globalResourceRegistry,
  globalPromptRegistry,
  globalTaskToolRegistry,
} from "../mcp/capabilities/registry/index.js";

import type { CreateServerOptions, CreateServerResult } from "./types.js";
import type { TransportOptions } from "./server-options.js";
import { getFrameworkConfig } from "../config/index.js";

// ============================================================================
// Transport Resolution
// ============================================================================

/**
 * Resolve transport from the config cascade when not provided programmatically.
 *
 * Reads `MCP_TRANSPORT`, `MCP_TLS_CERT_PATH`, and `MCP_TLS_KEY_PATH` from
 * the resolved framework config. Host and port are NOT set here — they
 * flow through the config cascade into `http-server.ts:resolveOptions()`.
 */
function resolveTransportFromConfig(): TransportOptions {
  const config = getFrameworkConfig();
  const mode = config.MCP_TRANSPORT;

  if (mode === "https") {
    const tls: { certPath: string; keyPath: string; caPath?: string } = {
      certPath: config.MCP_TLS_CERT_PATH ?? "",
      keyPath: config.MCP_TLS_KEY_PATH ?? "",
    };
    if (config.MCP_TLS_CA_PATH) {
      tls.caPath = config.MCP_TLS_CA_PATH;
    }
    return { mode: "https", tls };
  }

  if (mode === "http") {
    return { mode: "http" };
  }

  return { mode: "stdio" };
}

// ============================================================================
// Create Server Function
// ============================================================================

/**
 * Create an MCP server with automatic tool, resource, and prompt registration.
 *
 * This is the recommended way to create servers in the framework.
 * It automatically discovers and registers all items defined with
 * `defineTool()`, `defineResource()`, `defineResourceTemplate()`, and `definePrompt()`.
 *
 * @param options - Server configuration options
 * @returns Server instance with start() and stop() methods
 *
 * @example
 * ```typescript
 * // Minimal server with stdio transport
 * import { createServer, defineTool, text } from 'mcp-server-framework';
 * import { z } from 'zod';
 *
 * // This tool is auto-registered when the module loads
 * export const greetTool = defineTool({
 *   name: 'greet',
 *   description: 'Greet a user',
 *   input: z.object({ name: z.string() }),
 *   handler: async ({ name }) => text(`Hello, ${name}!`),
 * });
 *
 * // Create and start server
 * const server = createServer({
 *   name: 'greeting-server',
 *   version: '1.0.0',
 *   transport: { mode: 'stdio' },
 * });
 *
 * await server.start();
 * ```
 *
 * @example
 * ```typescript
 * // Server with HTTP transport
 * const server = createServer({
 *   name: 'http-server',
 *   version: '1.0.0',
 *   transport: { mode: 'http', port: 3000 },
 * });
 *
 * await server.start();
 * ```
 */
export function createServer(options: CreateServerOptions): CreateServerResult {
  const logger = baseLogger.child({ component: "create-server" });

  // Build server using McpServerBuilder
  const builder = new McpServerBuilder();

  // Warn when using default server identity — these should be set explicitly in production
  if (!options.name || !options.version) {
    logger.warn(
      "Server using default identity: name=%s version=%s — set name and version explicitly for production",
      options.name ?? DEFAULT_SERVER_NAME,
      options.version ?? DEFAULT_SERVER_VERSION,
    );
  }

  // Configure server options
  builder.withOptions({
    name: options.name ?? DEFAULT_SERVER_NAME,
    version: options.version ?? DEFAULT_SERVER_VERSION,
    transport: options.transport ?? resolveTransportFromConfig(),
    capabilities: options.capabilities,
    lifecycle: options.lifecycle,
    shutdown: options.shutdown,
    health: options.health,
    session: options.session,
    auth: options.auth,
    telemetryEnabled: options.telemetry ?? getTelemetryConfig().enabled,
    onBeforeTelemetryInit: options.onBeforeTelemetryInit,
  });

  // Register global registries as providers.
  // The registries implement Provider interfaces directly.
  builder.withToolProvider(globalToolRegistry);
  builder.withResourceProvider(globalResourceRegistry);
  builder.withPromptProvider(globalPromptRegistry);
  builder.withTaskToolProvider(globalTaskToolRegistry);

  // Build the server instance
  const instance = builder.build();

  // Return simplified interface
  return {
    start: () => instance.start(),
    stop: () => instance.stop(),
    initTelemetry: () => instance.initTelemetry(),
    notifyToolListChanged: () => instance.notifyToolListChanged(),
    notifyResourceListChanged: () => instance.notifyResourceListChanged(),
    notifyPromptListChanged: () => instance.notifyPromptListChanged(),
    notifyResourceUpdated: (uri: string) => instance.notifyResourceUpdated(uri),
  };
}
