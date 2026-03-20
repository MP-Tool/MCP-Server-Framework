/**
 * Session Module
 *
 * Unified session management for the MCP Server Framework.
 * The Session is the single source of truth for each connected MCP client.
 *
 * ## Architecture
 *
 * ```
 * Session (source of truth per client)
 * ├── id              (unique identifier)
 * ├── state           (lifecycle: created → active → closing → closed)
 * ├── transport       → TransportContext
 * │   ├── type        (http | sse | stdio)
 * │   ├── transport   (MCP SDK transport)
 * │   └── heartbeat   (state tracking)
 * ├── mcpSession      → McpSession
 * │   ├── sdk         (MCP SDK server)
 * │   └── register*() (SDK registration methods)
 * ├── auth            → AuthContext (auth/)
 * │   ├── sdkAuthInfo (SDK AuthInfo wrapper)
 * │   ├── userId?     (authenticated user)
 * │   └── permissions (access scopes)
 * ├── clientInfo      (name, version, remoteAddress)
 * └── metadata        → SessionMetadata (createdAt, lastActivityAt)
 * ```
 *
 * @module server/session
 */

// ============================================================================
// Transport Context
// ============================================================================

export type {
  TransportType,
  HeartbeatCapableTransport,
  HeartbeatState,
  TransportContext,
} from "../transport/transport-context.js";

export { createTransportContext, isHeartbeatCapable } from "../transport/transport-context.js";

// ============================================================================
// Auth Context (auth/)
// ============================================================================

export type { AuthInfo, AuthContext } from "../auth/index.js";

export { ANONYMOUS_AUTH, createAuthContext } from "../auth/index.js";

// ============================================================================
// Session
// ============================================================================

export type {
  SessionState,
  SessionCloseReason,
  ClientInfo,
  SessionMetadata,
  Session,
  ReadonlySession,
  CreateSessionOptions,
} from "./session.js";

export { createSession, SESSION_STATES, SESSION_CLOSE_REASONS } from "./session.js";

// ============================================================================
// Session Manager
// ============================================================================

export type {
  SessionConfig,
  SessionConfigInput,
  SessionLifecycleHooks,
  SessionStats,
  SessionManager,
} from "./session-manager.js";

export { SessionManagerImpl } from "./session-manager.js";

// ============================================================================
// Session Store (interface + built-in implementation)
// ============================================================================

export type { SessionStore } from "./session-store.js";
export { InMemorySessionStore } from "./in-memory-store.js";

// ============================================================================
// Session Housekeeper (internal building block, exposed for advanced use)
// ============================================================================

export { SessionHousekeeper, type HousekeeperConfig, type CloseSessionCallback } from "./session-housekeeper.js";

// ============================================================================
// MCP Session (per-client SDK wrapper)
// ============================================================================

export { McpSession, type McpSessionOptions, type CloseCallback, type ErrorCallback } from "./mcp-session.js";

// ============================================================================
// MCP Session Factory
// ============================================================================

export { McpSessionFactory, type SessionFactoryConfig } from "./session-factory.js";
