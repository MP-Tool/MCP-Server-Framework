/**
 * Trust Proxy Resolution
 *
 * Validates and resolves the `MCP_TRUST_PROXY` configuration value into
 * a type-safe Express-compatible trust proxy setting.
 *
 * Supported value formats:
 * - **Hop count**: Integer string (`'1'`, `'2'`) → `number` for Express
 * - **Express keywords**: `'loopback'`, `'linklocal'`, `'uniquelocal'`
 * - **IP addresses**: IPv4 or IPv6 (`'10.0.0.1'`, `'::1'`)
 * - **CIDR ranges**: `'10.0.0.0/8'`, `'172.16.0.0/12'`
 * - **DNS hostnames**: Resolved to IP at startup (`'proxy.example.com'`)
 * - **Comma-separated lists**: `'loopback, 10.0.0.1, proxy.internal'`
 *
 * Invalid values or unresolvable hostnames throw `ConfigurationError`.
 * `undefined` or empty string → `undefined` (trust proxy disabled).
 *
 * @module server/middleware/trust-proxy
 */

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

import { ConfigurationError } from "../../errors/index.js";
import { logger as baseLogger } from "../../logger/index.js";

// ============================================================================
// Constants
// ============================================================================

const ENV_VAR = "MCP_TRUST_PROXY";

/** Express built-in trust proxy keywords. */
const TRUST_PROXY_KEYWORDS: ReadonlySet<string> = new Set(["loopback", "linklocal", "uniquelocal"]);

/** Pattern for CIDR notation: IP address followed by /prefix-length. */
const CIDR_PATTERN = /^.+\/\d{1,3}$/;

const logger = baseLogger.child({ component: "trust-proxy" });

const TrustProxyLogMessages = {
  RESOLVED_HOSTNAME: "Resolved trust proxy hostname %s → %s",
  TRUST_PROXY_ACTIVE: "Trust proxy enabled: %s",
} as const;

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve a raw trust proxy config string into an Express-compatible value.
 *
 * This function validates each segment of the (possibly comma-separated)
 * value. DNS hostnames are resolved to IP addresses at startup time.
 *
 * @param value - Raw config string from `MCP_TRUST_PROXY`
 * @returns Resolved value for `app.set('trust proxy', ...)`:
 *   - `number` for hop-count values
 *   - `string` for IP/CIDR/keyword (possibly comma-separated)
 *   - `undefined` when trust proxy is disabled
 * @throws {ConfigurationError} if a segment is invalid or DNS resolution fails
 */
export async function resolveTrustProxy(value: string | undefined): Promise<string | number | undefined> {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const trimmed = value.trim();

  // ── Hop count (pure integer) ─────────────────────────────────────────
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1) {
    logger.info(TrustProxyLogMessages.TRUST_PROXY_ACTIVE, String(asNumber));
    return asNumber;
  }

  // Guard: "0" or negative integers are not valid hop counts
  if (Number.isInteger(asNumber) && asNumber <= 0) {
    throw ConfigurationError.invalidEnvVar(ENV_VAR, `Hop count must be ≥ 1, got ${trimmed}`);
  }

  // ── Segment-wise validation (comma-separated) ───────────────────────
  const rawSegments = trimmed.split(",");
  const resolvedSegments: string[] = [];

  for (const raw of rawSegments) {
    const segment = raw.trim();
    if (segment === "") continue;

    const resolved = await resolveSegment(segment);
    resolvedSegments.push(resolved);
  }

  if (resolvedSegments.length === 0) {
    return undefined;
  }

  const result = resolvedSegments.length === 1 ? resolvedSegments[0] : resolvedSegments.join(", ");

  logger.info(TrustProxyLogMessages.TRUST_PROXY_ACTIVE, result);
  return result;
}

export { TRUST_PROXY_KEYWORDS };

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Validate and resolve a single trust proxy segment.
 *
 * Order of checks:
 * 1. Express keyword (`loopback`, `linklocal`, `uniquelocal`)
 * 2. IP address (IPv4 or IPv6)
 * 3. CIDR range (IP/prefix)
 * 4. DNS hostname → resolve to IP
 */
async function resolveSegment(segment: string): Promise<string> {
  // 1. Express keyword
  if (TRUST_PROXY_KEYWORDS.has(segment)) {
    return segment;
  }

  // 2. Plain IP address
  if (isIP(segment) !== 0) {
    return segment;
  }

  // 3. CIDR notation — validate the IP part
  if (CIDR_PATTERN.test(segment)) {
    const slashIndex = segment.lastIndexOf("/");
    const ipPart = segment.substring(0, slashIndex);
    const prefixStr = segment.substring(slashIndex + 1);
    const prefix = Number(prefixStr);

    if (isIP(ipPart) === 0) {
      throw ConfigurationError.invalidEnvVar(ENV_VAR, `Invalid IP in CIDR notation: '${segment}'`);
    }

    const maxPrefix = isIP(ipPart) === 4 ? 32 : 128;
    if (prefix < 0 || prefix > maxPrefix) {
      throw ConfigurationError.invalidEnvVar(
        ENV_VAR,
        `CIDR prefix out of range (0–${String(maxPrefix)}): '${segment}'`,
      );
    }

    return segment;
  }

  // 4. DNS hostname — resolve at startup
  return resolveHostname(segment);
}

/**
 * Resolve a DNS hostname to an IP address.
 *
 * Uses `dns.promises.lookup()` which respects the OS resolver configuration
 * (including `/etc/hosts`). Only the first resolved address is used.
 *
 * @throws {ConfigurationError} if DNS resolution fails or the hostname
 *   contains invalid characters
 */
async function resolveHostname(hostname: string): Promise<string> {
  // Basic hostname validation (RFC 1123)
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(hostname)) {
    throw ConfigurationError.invalidEnvVar(
      ENV_VAR,
      `Invalid trust proxy value: '${hostname}' (not a keyword, IP, CIDR, or valid hostname)`,
    );
  }

  const DNS_TIMEOUT_MS = 5_000;
  try {
    const lookup = dns.lookup(hostname);
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
      timer.unref();
    });
    const { address } = await Promise.race([lookup, timeout]);
    logger.info(TrustProxyLogMessages.RESOLVED_HOSTNAME, hostname, address);
    return address;
  } catch (_cause) {
    throw ConfigurationError.invalidEnvVar(ENV_VAR, `Cannot resolve hostname '${hostname}': DNS lookup failed`);
  }
}
