/**
 * Session Types
 *
 * The Session is the single source of truth for a connected MCP client.
 * It composes transport, auth, and MCP session contexts into one unified entity.
 *
 * @module server/session/session
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpSession } from "./mcp-session.js";
import type { TransportType, TransportContext } from "../transport/transport-context.js";
import { createTransportContext } from "../transport/transport-context.js";
import { ANONYMOUS_AUTH, type AuthContext } from "../auth/index.js";

// ============================================================================
// Session Lifecycle
// ============================================================================

/**
 * Session lifecycle state constants.
 *
 * Single source of truth — use these instead of raw string literals.
 */
export const SESSION_STATES = {
  CREATED: "created",
  ACTIVE: "active",
  CLOSING: "closing",
  CLOSED: "closed",
} as const;

/**
 * Session lifecycle states.
 */
export type SessionState = (typeof SESSION_STATES)[keyof typeof SESSION_STATES];

/**
 * Reason for session closure.
 *
 * Single source of truth — use `SESSION_CLOSE_REASONS.*` instead of raw string literals.
 */
export const SESSION_CLOSE_REASONS = {
  CLIENT_DISCONNECT: "client_disconnect",
  TIMEOUT: "timeout",
  HEARTBEAT_FAILURE: "heartbeat_failure",
  ERROR: "error",
  SHUTDOWN: "shutdown",
  REPLACED: "replaced",
} as const;

/**
 * Session close reason type (derived from const object).
 */
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[keyof typeof SESSION_CLOSE_REASONS];

// ============================================================================
// Client Info
// ============================================================================

/**
 * Information about the connected client.
 *
 * Captured from MCP initialize request and HTTP headers.
 */
export interface ClientInfo {
  /** Client name from MCP initialization */
  name?: string | undefined;

  /** Client version from MCP initialization */
  version?: string | undefined;

  /** Remote IP address (for HTTP connections) */
  remoteAddress?: string | undefined;

  /** User agent header (for HTTP connections) */
  userAgent?: string | undefined;
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Session lifecycle and timing metadata.
 *
 * Grouped separately from core session identity for clean serialization
 * and future Session Store support (Phase 4.3 — Redis-ready).
 */
export interface SessionMetadata {
  /** When the session was created */
  readonly createdAt: Date;

  /** Last activity timestamp (updated on touch) */
  lastActivityAt: Date;
}

// ============================================================================
// Session (Single Source of Truth)
// ============================================================================

/**
 * A unified session representing a single connected MCP client.
 *
 * The Session is the **source of truth** for everything related to a client connection.
 * It directly owns the MCP session (SDK bridge), transport context, and auth context.
 *
 * ## Composition
 * ```
 * Session
 * ├── id            (unique identifier)
 * ├── state         (lifecycle: created → active → closing → closed)
 * ├── transport     → TransportContext (type, instance, heartbeat)
 * ├── mcpSession    → McpSession (SDK server, request manager)
 * ├── auth          → AuthContext (SDK AuthInfo + framework permissions)
 * ├── clientInfo    → ClientInfo (name, version, remoteAddress)
 * └── metadata      → SessionMetadata (createdAt, lastActivityAt)
 * ```
 */
export interface Session {
  /** Unique session identifier (from transport or generated) */
  readonly id: string;

  /** Current lifecycle state */
  state: SessionState;

  /** Transport-layer context */
  readonly transport: TransportContext;

  /** MCP session — SDK server wrapper with per-client request manager */
  readonly mcpSession: McpSession;

  /** Authentication context (immutable after creation) */
  readonly auth: AuthContext;

  /** Client information (populated after initialize) */
  clientInfo: ClientInfo;

  /** Session timing and lifecycle metadata */
  readonly metadata: SessionMetadata;
}

/**
 * Read-only view of a Session for external consumers.
 * Used in forEach callbacks and other external-facing APIs.
 */
export type ReadonlySession = Readonly<Session>;

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  /** Session ID (if undefined, will be generated) */
  id?: string;

  /** Transport type */
  transportType: TransportType;

  /** MCP SDK transport instance */
  transport: Transport;

  /** Managed MCP session instance */
  mcpSession: McpSession;

  /** Initial auth context (defaults to anonymous) */
  auth?: AuthContext;

  /** Initial client info */
  clientInfo?: Partial<ClientInfo>;
}

/**
 * Factory function to create a composed session.
 */
export function createSession(options: CreateSessionOptions): Session {
  const now = new Date();

  return {
    id: options.id ?? crypto.randomUUID(),
    state: SESSION_STATES.CREATED,
    transport: createTransportContext(options.transportType, options.transport),
    mcpSession: options.mcpSession,
    auth: options.auth ?? ANONYMOUS_AUTH,
    clientInfo: {
      name: options.clientInfo?.name,
      version: options.clientInfo?.version,
      remoteAddress: options.clientInfo?.remoteAddress,
      userAgent: options.clientInfo?.userAgent,
    },
    metadata: {
      createdAt: now,
      lastActivityAt: now,
    },
  };
}
