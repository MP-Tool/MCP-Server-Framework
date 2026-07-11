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
import { getFrameworkConfig, type FrameworkEnvConfig } from "../../config/index.js";
import { registerCacheReset } from "../../config/config-cache.js";
import { isLocalHost } from "../../utils/string-helpers.js";
import { createJsonRpcError, HttpStatus, JsonRpcErrorCode, TransportErrorMessage } from "../../errors/index.js";
import { logSecurityEvent, truncateForLog } from "./logging.js";

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

  // If MCP_ALLOWED_HOSTS is set, we strictly enforce that list (no implicit localhost bypass).
  // If not set, we allow defaults AND any localhost port (to support Docker port mapping).
  const strictMode = !!config.MCP_ALLOWED_HOSTS;

  // Shared allow-check — used for both the Host header and the Origin header host.
  // Normalize to lowercase (RFC 7230: Host is case-insensitive).
  const isHostAllowed = (candidate: string): boolean => {
    const clean = candidate.trim().toLowerCase();
    return strictMode ? allowedHosts.includes(clean) : isLocalHost(clean) || allowedHosts.includes(clean);
  };

  // Validate Host header (MUST for all configurations).
  if (!host || !isHostAllowed(host)) {
    logSecurityEvent(`DNS Rebinding attempt blocked: Host=${truncateForLog(host)}`);
    res
      .status(HttpStatus.FORBIDDEN)
      .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.DNS_REBINDING_BLOCKED));
    return;
  }

  // Validate Origin header as defense-in-depth (MCP 2025-06-18 SHOULD). A DNS-rebound page
  // reaches us with a foreign Origin; a same-origin browser client sends a matching one.
  // Origin is `scheme://host[:port]`; compare its `host` (matches the allowlist/Host format,
  // including `[::1]` and non-default ports). Absent Origin is allowed — non-browser MCP
  // clients omit it, and the Host check above still applies to every request.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined; // malformed Origin → reject below
    }
    if (originHost === undefined || !isHostAllowed(originHost)) {
      logSecurityEvent(`DNS Rebinding attempt blocked: Origin=${truncateForLog(origin)}`);
      res
        .status(HttpStatus.FORBIDDEN)
        .json(createJsonRpcError(JsonRpcErrorCode.SERVER_ERROR, TransportErrorMessage.DNS_REBINDING_BLOCKED));
      return;
    }
  }

  next();
}
