/**
 * Transport Configuration Types
 *
 * User-facing transport configuration types for the MCP server.
 * These types define how consumers configure transport mode, TLS, HTTP options, etc.
 *
 * @module server/transport-options
 */

import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ============================================================================
// Transport Configuration
// ============================================================================

/**
 * Transport modes supported by the MCP framework.
 *
 * - `stdio` — Single-client CLI mode
 * - `http` — Multi-client HTTP mode
 * - `https` — Multi-client HTTPS mode with TLS
 */
export type TransportMode = "stdio" | "http" | "https";

/**
 * TLS configuration for HTTPS transport.
 *
 * Certificate files are read from the filesystem at server startup.
 * Required when transport mode is 'https'.
 */
export interface TlsConfig {
  /** Path to the TLS certificate file (PEM format) */
  readonly certPath: string;
  /** Path to the TLS private key file (PEM format) */
  readonly keyPath: string;
  /** Optional path to the CA certificate file (PEM format) */
  readonly caPath?: string;
}

/**
 * Shared HTTP/HTTPS transport options.
 *
 * Contains all configuration common to both `http` and `https` modes.
 * Used as the base for the discriminated union members.
 */
export interface BaseHttpTransportOptions {
  /** Port to listen on (default: 8000 or MCP_PORT env) */
  port?: number;

  /** Host to bind to (default: '127.0.0.1' or MCP_BIND_HOST env) */
  host?: string;

  /** Enable legacy SSE transport for backwards compatibility */
  legacySseEnabled?: boolean;

  /** Rate limiting: max requests per window */
  rateLimitMax?: number;

  /** Rate limiting: window duration in ms */
  rateLimitWindowMs?: number;

  /**
   * Trust proxy setting for Express.
   *
   * Required when running behind a reverse proxy (nginx, Traefik, cloud LB)
   * to correctly resolve client IPs, protocol, and host from proxy headers
   * (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`).
   *
   * Values:
   * - Hop count (`'1'`, `'2'`) — Trust N hops from the front-facing proxy
   * - Express keyword (`'loopback'`, `'linklocal'`, `'uniquelocal'`)
   * - IP/CIDR (`'10.0.0.1'`, `'10.0.0.0/8'`)
   * - DNS hostname (`'proxy.example.com'`) — resolved at startup
   * - Comma-separated list (`'loopback, 10.0.0.1'`)
   *
   * Can also be configured via `MCP_TRUST_PROXY` env var or config file.
   * Omit to disable trust proxy.
   *
   * @see https://expressjs.com/en/guide/behind-proxies.html
   */
  trustProxy?: string;

  /**
   * Operate in stateless mode (no session IDs).
   *
   * When enabled, each request gets a fresh McpSession and SDK transport.
   * No Mcp-Session-Id headers are set. Per MCP specification, stateless
   * servers do not track individual client sessions.
   *
   * In stateless mode, GET and DELETE return 405 Method Not Allowed.
   *
   * Use cases:
   * - Simple tool servers that don't need per-client state
   * - Serverless/edge deployments where session persistence is impractical
   * - Horizontal scaling behind round-robin load balancers
   *
   * @default false
   */
  stateless?: boolean;

  /**
   * Prefer JSON responses over SSE streams for simple request-response.
   *
   * When enabled, the SDK returns `application/json` for non-streaming
   * responses (e.g. tools/list, resources/list) instead of wrapping them
   * in a `text/event-stream` SSE envelope.
   *
   * The MCP specification recommends: "If the server is only sending one
   * response with no notifications, it SHOULD prefer application/json."
   *
   * Streaming responses (progress, notifications) always use SSE regardless.
   *
   * Can also be configured via `MCP_JSON_RESPONSE` env var or config file.
   *
   * @default true (spec-compliant JSON responses)
   */
  enableJsonResponse?: boolean;

  /**
   * Event store for stream resumability.
   *
   * When provided, the SDK transport stores events and supports
   * client reconnection via the `Last-Event-ID` header. Only meaningful
   * in stateful mode — stateless requests have no persistent streams.
   *
   * The SDK provides `InMemoryEventStore` as a reference implementation.
   * For production horizontal scaling, implement the `EventStore` interface
   * with Redis, PostgreSQL, or another shared backend.
   *
   * @example
   * ```typescript
   * import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
   *
   * createServer({
   *   name: 'my-server',
   *   version: '1.0.0',
   *   transport: { mode: 'http', eventStore: new InMemoryEventStore() },
   * });
   * ```
   */
  eventStore?: EventStore;

  // ── CORS ──────────────────────────────────────────────────────────────────

  /**
   * CORS allowed origins.
   *
   * When set, CORS middleware is mounted globally and allows requests
   * from the listed origins. When omitted, CORS is disabled.
   *
   * Use `['*']` to allow all origins (not recommended for production).
   *
   * Can also be configured via `MCP_CORS_ORIGIN` env var (comma-separated)
   * or `[security] cors_origin` in the config file.
   *
   * @example ['https://app.example.com', 'https://admin.example.com']
   */
  corsOrigin?: string[];

  /**
   * Allow credentials in CORS requests (cookies, auth headers).
   *
   * Only effective when `corsOrigin` is set.
   * Cannot be used with `corsOrigin: ['*']`.
   *
   * Can also be configured via `MCP_CORS_CREDENTIALS` env var.
   *
   * @default false
   */
  corsCredentials?: boolean;

  // ── Helmet ────────────────────────────────────────────────────────────────

  /**
   * Enable HTTP Strict Transport Security (HSTS) header.
   *
   * When true, Helmet sets `Strict-Transport-Security` with `max-age=15552000`
   * (180 days) and `includeSubDomains`. Only enable when serving over HTTPS.
   *
   * Can also be configured via `MCP_HELMET_HSTS` env var.
   *
   * @default false
   */
  helmetHsts?: boolean;

  /**
   * Content Security Policy configuration.
   *
   * - Omit: Helmet default CSP applies
   * - `'false'`: Disable CSP entirely
   * - Custom string: CSP directives (e.g. `"default-src 'self'; script-src 'none'"`)
   *
   * Can also be configured via `MCP_HELMET_CSP` env var.
   */
  helmetCsp?: string;

  /**
   * X-Frame-Options header value.
   *
   * - `'DENY'` — Never allow framing (most secure)
   * - `'SAMEORIGIN'` — Allow from same origin
   * - `'false'` — Disable X-Frame-Options header
   *
   * Can also be configured via `MCP_HELMET_FRAME_OPTIONS` env var.
   *
   * @default 'DENY'
   */
  helmetFrameOptions?: "DENY" | "SAMEORIGIN" | "false";
}

// ── Discriminated Union Members ──────────────────────────────────────────────

/**
 * Stdio transport — single-client CLI mode.
 *
 * No HTTP options are available. Uses stdin/stdout for MCP protocol data.
 */
export interface StdioTransportOptions {
  mode: "stdio";
}

/**
 * HTTP transport — multi-client mode without TLS.
 *
 * Use behind a reverse proxy that handles TLS termination,
 * or for local development.
 */
export interface HttpTransportOptions extends BaseHttpTransportOptions {
  mode: "http";
}

/**
 * HTTPS transport — multi-client mode with TLS.
 *
 * Requires TLS certificate configuration. Use for direct TLS termination
 * without a reverse proxy.
 */
export interface HttpsTransportOptions extends BaseHttpTransportOptions {
  mode: "https";

  /**
   * TLS configuration (required for HTTPS mode).
   *
   * Can also be configured via environment variables:
   * - MCP_TLS_CERT_PATH
   * - MCP_TLS_KEY_PATH
   * - MCP_TLS_CA_PATH (optional)
   */
  tls: TlsConfig;
}

/**
 * Transport configuration — discriminated union by `mode`.
 *
 * TypeScript narrows the available options based on the selected mode:
 * - `{ mode: 'stdio' }` — no additional options
 * - `{ mode: 'http', port: 8000, ... }` — flat HTTP options
 * - `{ mode: 'https', port: 8443, tls: { ... }, ... }` — flat HTTPS options with required TLS
 *
 * @example
 * ```typescript
 * // Stdio
 * transport: { mode: 'stdio' }
 *
 * // HTTP
 * transport: { mode: 'http', port: 8000, host: '0.0.0.0' }
 *
 * // HTTPS
 * transport: { mode: 'https', port: 8443, tls: { certPath: '/certs/cert.pem', keyPath: '/certs/key.pem' } }
 * ```
 */
export type TransportOptions = StdioTransportOptions | HttpTransportOptions | HttpsTransportOptions;

/**
 * Type guard: checks whether the transport is an HTTP-based mode (http or https).
 *
 * After this guard, TypeScript narrows to `HttpTransportOptions | HttpsTransportOptions`,
 * allowing direct access to `port`, `host`, `stateless`, etc.
 */
export function isHttpTransport(
  transport: TransportOptions,
): transport is HttpTransportOptions | HttpsTransportOptions {
  return transport.mode === "http" || transport.mode === "https";
}
