/**
 * Server Module
 *
 * High-level API for creating MCP servers with minimal boilerplate.
 * Re-exports builder, session, and transport for convenience.
 *
 * @module server
 */

// ─────────────────────────────────────────────────────────────────────────────
// Create Server (main entry point)
// ─────────────────────────────────────────────────────────────────────────────

export { createServer } from "./create-server.js";
export { configureLoggerFromEnv } from "./logger-config.js";

export type { CreateServerOptions, CreateServerResult } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Server Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

export { isHttpTransport } from "./server-options.js";

export type {
  TransportMode,
  BaseHttpTransportOptions,
  StdioTransportOptions,
  HttpTransportOptions,
  HttpsTransportOptions,
  TransportOptions,
  TlsConfig,
  ServerCapabilities,
  ReadinessConfig,
  SessionConfigOptions,
  ServerOptions,
  ServerInstance,
} from "./server-options.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Types
// ─────────────────────────────────────────────────────────────────────────────

export type { ServerLifecycleHooks, ShutdownConfig } from "./lifecycle.js";

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

export { McpServerBuilder } from "./builder/index.js";

export type { ServerBuilder } from "./builder/index.js";
