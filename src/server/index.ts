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
  HealthConfig,
  SessionConfigOptions,
  ServerOptions,
  ServerInstance,
} from "./server-options.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Types
// ─────────────────────────────────────────────────────────────────────────────

export type { ServerState, ServerLifecycleHooks, ShutdownConfig } from "./lifecycle.js";

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

export { McpServerBuilder } from "./builder/index.js";

export type { ServerBuilder } from "./builder/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Session (includes SessionFactory, Manager, Store, MCP Session)
// ─────────────────────────────────────────────────────────────────────────────

export {
  McpSessionFactory,
  SessionManagerImpl,
  InMemorySessionStore,
  SessionHousekeeper,
  McpSession,
  // Factories
  createSession,
  createAuthContext,
  ANONYMOUS_AUTH,
  SESSION_CLOSE_REASONS,
} from "./session/index.js";

export type {
  SessionFactoryConfig,
  Session,
  SessionManager,
  SessionStore,
  SessionConfig,
  SessionStats,
  HousekeeperConfig,
  AuthContext,
  ClientInfo,
  SessionState,
  SessionCloseReason,
  CreateSessionOptions,
} from "./session/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

export type {
  SessionFactory,
  TransportHandle,
  TransportInfo,
  TransportType,
  TransportState,
  TransportContext,
  HeartbeatCapableTransport,
  HeartbeatState,
} from "./transport/types.js";

export { createTransportContext, isHeartbeatCapable } from "./transport/types.js";

export type { HttpTransportStartOptions, HttpServerOptions, HttpsServerOptions } from "./http/index.js";

// Only stdio is statically exported from this barrel.
// Express-dependent HTTP transport functions (startHttpTransport, createExpressApp,
// startHttpServer, startHttpsServer, readTlsCredentials) are available via the
// 'mcp-server-framework/http' subpath import.
// This prevents Express from loading at import time, allowing OTEL instrumentation
// to initialize before Express is required.
export { startStdioTransport } from "./transport/stdio-transport.js";

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// ReadinessStatus from dedicated module — avoids loading Express via routes barrel.
// createHealthRouter is framework-internal (used by createExpressApp).
export { ReadinessStatus } from "./routes/readiness-status.js";
export type { ReadinessStatusValue } from "./routes/readiness-status.js";
export type { HealthRouterOptions, SseInfoProvider } from "./routes/index.js";
