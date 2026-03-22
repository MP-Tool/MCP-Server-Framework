/**
 * Programmatic Option → Config Overrides
 *
 * Pure mapping function that bridges programmatic ServerOptions into
 * FrameworkEnvConfig overrides. Extracted from McpServerInstance for
 * testability and to reduce class complexity.
 *
 * @module server/option-overrides
 * @internal
 */

import type { ServerOptions } from "./server-options.js";
import { isHttpTransport } from "./server-options.js";
import type { FrameworkEnvConfig } from "../config/index.js";

/**
 * Maps programmatic server options to config override entries.
 *
 * This is a pure function — it reads `currentConfig` only to check
 * whether OTEL_SERVICE_NAME is already set (avoiding accidental override).
 *
 * @param options - The server options from createServer() or McpServerBuilder
 * @param currentConfig - The current resolved framework config
 * @returns Partial config overrides to apply (empty object if none)
 * @internal
 */
export function mapServerOptionsToOverrides(
  options: ServerOptions,
  currentConfig: FrameworkEnvConfig,
): Partial<FrameworkEnvConfig> {
  const overrides: Partial<FrameworkEnvConfig> = {};

  // Always bridge version — createServer({ version }) is the canonical source
  overrides.VERSION = options.version;

  // Bridge server name as OTEL service name default.
  // The MCP server name is the natural default — env var or config file
  // can override it for deployment-specific naming (e.g. 'my-app-prod').
  if (options.name && !currentConfig.OTEL_SERVICE_NAME) {
    overrides.OTEL_SERVICE_NAME = options.name;
  }

  // Bridge transport HTTP options (discriminated union — narrowed by isHttpTransport)
  const transport = options.transport;
  if (transport && isHttpTransport(transport)) {
    if (transport.legacySseEnabled !== undefined) {
      overrides.MCP_LEGACY_SSE_ENABLED = transport.legacySseEnabled;
    }
    if (transport.port !== undefined) {
      overrides.MCP_PORT = transport.port;
    }
    if (transport.host !== undefined) {
      overrides.MCP_BIND_HOST = transport.host;
    }
    if (transport.rateLimitMax !== undefined) {
      overrides.MCP_RATE_LIMIT_MAX = transport.rateLimitMax;
    }
    if (transport.rateLimitWindowMs !== undefined) {
      overrides.MCP_RATE_LIMIT_WINDOW_MS = transport.rateLimitWindowMs;
    }
    if (transport.trustProxy !== undefined) {
      overrides.MCP_TRUST_PROXY = transport.trustProxy;
    }
    if (transport.stateless !== undefined) {
      overrides.MCP_STATELESS = transport.stateless;
    }
    if (transport.enableJsonResponse !== undefined) {
      overrides.MCP_JSON_RESPONSE = transport.enableJsonResponse;
    }
    if (transport.corsOrigin !== undefined) {
      overrides.MCP_CORS_ORIGIN = transport.corsOrigin;
    }
    if (transport.corsCredentials !== undefined) {
      overrides.MCP_CORS_CREDENTIALS = transport.corsCredentials;
    }
    if (transport.helmetHsts !== undefined) {
      overrides.MCP_HELMET_HSTS = transport.helmetHsts;
    }
    if (transport.helmetCsp !== undefined) {
      overrides.MCP_HELMET_CSP = transport.helmetCsp;
    }
    if (transport.helmetFrameOptions !== undefined) {
      overrides.MCP_HELMET_FRAME_OPTIONS = transport.helmetFrameOptions;
    }
  }

  // Bridge programmatic session options → config cache (limits only)
  const session = options.session;
  if (session) {
    if (session.maxSessions !== undefined) {
      overrides.MCP_MAX_SESSIONS = session.maxSessions;
    }
  }

  return overrides;
}
