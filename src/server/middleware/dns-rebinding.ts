/**
 * DNS Rebinding Protection middleware
 * MCP Spec 2025-06-18 MUST requirement
 *
 * SECURITY NOTE: This middleware validates the Host header to prevent
 * DNS rebinding attacks. For production deployments:
 * - Always run behind a reverse proxy (nginx, traefik) with proper TLS
 * - Configure explicit MCP_ALLOWED_HOSTS
 *
 * @module server/middleware/dns-rebinding
 */

import type { Request, Response, NextFunction } from "express";
import { getFrameworkConfig, registerCacheReset, type FrameworkEnvConfig } from "../../config/index.js";
import { isLocalHost } from "../../utils/string-helpers.js";
import { createJsonRpcError, HttpStatus, JsonRpcErrorCode, TransportErrorMessage } from "../../errors/index.js";
import { logSecurityEvent, sanitizeForLog } from "./logging.js";

// ============================================================================
// Security Configuration
// ============================================================================

/**
 * Creates allowed hosts list for DNS rebinding protection.
 *
 * Returns the configured allowed hosts or defaults to localhost variants.
 * The returned list is used by middleware to validate Host headers.
 *
 * @param config - Framework environment configuration
 * @returns Array of allowed host strings (e.g., ['localhost:3000', '127.0.0.1:3000'])
 */
function createAllowedHosts(config: FrameworkEnvConfig): string[] {
  const port = config.MCP_PORT;
  // prettier-ignore
  const defaults = [
    'localhost',
    '127.0.0.1',
    '[::1]',
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ];

  if (config.MCP_ALLOWED_HOSTS && config.MCP_ALLOWED_HOSTS.length > 0) {
    // Normalize to lowercase — RFC 7230: Host header is case-insensitive
    return config.MCP_ALLOWED_HOSTS.map((h) => h.toLowerCase());
  }

  return defaults;
}

/** Cached derived value (lazy initialization) */
let cachedAllowedHosts: string[] | undefined;

// Self-register for central cache reset
registerCacheReset(resetDnsRebindingCache);

/**
 * Gets or creates cached allowed hosts list.
 */
function getAllowedHosts(): string[] {
  if (!cachedAllowedHosts) {
    cachedAllowedHosts = createAllowedHosts(getFrameworkConfig());
  }
  return cachedAllowedHosts;
}

/**
 * Resets the cached allowed hosts.
 * Called by the central config reset to maintain cache coherence.
 *
 * @internal
 */
export function resetDnsRebindingCache(): void {
  cachedAllowedHosts = undefined;
}

/**
 * DNS Rebinding Protection Middleware
 * Validates Host header to prevent DNS rebinding attacks (MCP Spec MUST)
 */
export function dnsRebindingProtection(req: Request, res: Response, next: NextFunction): void {
  const config = getFrameworkConfig();
  const host = req.headers.host;
  const allowedHosts = getAllowedHosts();

  // Validate Host header (MUST for all configurations)
  // We allow localhost/127.0.0.1 on ANY port to support Docker port mapping ONLY if no custom hosts are defined
  // Normalize to lowercase — RFC 7230: Host header is case-insensitive
  const cleanHost = host ? host.trim().toLowerCase() : "";

  // If MCP_ALLOWED_HOSTS is set, we strictly enforce that list (no implicit localhost bypass).
  // If not set, we allow defaults AND any localhost port (to support Docker port mapping).
  const strictMode = !!config.MCP_ALLOWED_HOSTS;
  const isAllowed = strictMode
    ? allowedHosts.includes(cleanHost)
    : isLocalHost(cleanHost) || allowedHosts.includes(cleanHost);

  if (!host || !isAllowed) {
    logSecurityEvent(`DNS Rebinding attempt blocked: Host=${sanitizeForLog(host)}`);
    res
      .status(HttpStatus.FORBIDDEN)
      .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.DNS_REBINDING_BLOCKED));
    return;
  }

  next();
}
