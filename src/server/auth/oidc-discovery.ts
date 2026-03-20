/**
 * OIDC Discovery Client
 *
 * Fetches and caches OpenID Connect Discovery documents (RFC 8414 / OpenID Connect Discovery 1.0).
 * Used by {@link createOidcProvider} to auto-discover upstream OAuth endpoints.
 *
 * The discovery document is fetched from `{issuer}/.well-known/openid-configuration`
 * and cached with a configurable TTL (default: 1 hour). Subsequent calls to
 * {@link getOidcDiscovery} return the cached version until the TTL expires.
 *
 * @example
 * ```typescript
 * const doc = await getOidcDiscovery('https://auth.example.com');
 * console.log(doc.authorization_endpoint); // https://auth.example.com/authorize
 * console.log(doc.token_endpoint);         // https://auth.example.com/token
 * ```
 *
 * @module server/auth/oidc-discovery
 */

import { logger as baseLogger } from "../../logger/index.js";

// ============================================================================
// Logger
// ============================================================================

const LOG_COMPONENT = "oidc-discovery";

const LogMessages = {
  FETCHING: "Fetching OIDC discovery from %s",
  CACHED: "Using cached OIDC discovery for %s (age: %ds)",
  REFRESHING: "Refreshing expired OIDC discovery for %s (age: %ds, ttl: %ds)",
  FETCHED: "OIDC discovery fetched: authorization=%s token=%s userinfo=%s",
  MISSING_FIELDS: "OIDC discovery at %s missing required fields: %s",
  FETCH_FAILED: "OIDC discovery fetch failed for %s: %s",
  ISSUER_MISMATCH: "OIDC discovery issuer mismatch: expected %s, got %s",
  SSRF_BLOCKED: "OIDC discovery blocked: %s — %s",
} as const;

const logger = baseLogger.child({ component: LOG_COMPONENT });

// ============================================================================
// Constants
// ============================================================================

/** Default TTL for cached discovery documents (1 hour) */
const DEFAULT_DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Default timeout for OIDC discovery fetch requests (10 seconds) */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Well-known path suffix for OIDC discovery */
const WELL_KNOWN_PATH = "/.well-known/openid-configuration";

/** Maximum number of cached OIDC discovery documents */
const MAX_DISCOVERY_CACHE_SIZE = 50;

/**
 * Hostnames and IP patterns that must never be fetched (SSRF protection).
 * Covers private IPv4 ranges (RFC 1918), link-local, loopback, and cloud metadata endpoints.
 */
const BLOCKED_HOST_PATTERNS: readonly RegExp[] = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // IPv4 loopback
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.0.0/16
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Link-local
  /^0\.0\.0\.0$/, // Unspecified
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?::ffff:/i, // IPv6-mapped IPv4 (e.g. ::ffff:192.168.1.1)
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?fc00:/i, // IPv6 unique local
  /^\[?fd/i, // IPv6 unique local
];

/** Hostnames that are always blocked regardless of scheme */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal", // GCP metadata
  "metadata.azure.internal", // Azure metadata (IMDS hostname variant)
]);

// ============================================================================
// Types
// ============================================================================

/**
 * Subset of an OpenID Connect Discovery document relevant for OAuth proxy flows.
 *
 * @see https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata
 */
export interface OidcDiscoveryDocument {
  /** REQUIRED. URL of the authorization endpoint */
  readonly authorization_endpoint: string;

  /** REQUIRED. URL of the token endpoint */
  readonly token_endpoint: string;

  /** RECOMMENDED. URL of the UserInfo endpoint */
  readonly userinfo_endpoint?: string;

  /** URL of the token revocation endpoint (RFC 7009) */
  readonly revocation_endpoint?: string;

  /** JSON array of OAuth 2.0 scope values supported */
  readonly scopes_supported?: readonly string[];

  /** JSON array of client authentication methods supported at the token endpoint */
  readonly token_endpoint_auth_methods_supported?: readonly string[];

  /** The issuer identifier (must match the requested issuer URL) */
  readonly issuer?: string;
}

/** Internal cache entry */
interface CacheEntry {
  readonly document: OidcDiscoveryDocument;
  readonly fetchedAt: number;
}

// ============================================================================
// Cache
// ============================================================================

const discoveryCache = new Map<string, CacheEntry>();

// ============================================================================
// SSRF Protection
// ============================================================================

/**
 * Validates a URL against SSRF attacks before fetching.
 *
 * Rules:
 * - Only `https:` is allowed in production. `http:` is permitted only for
 *   `localhost` / `127.0.0.1` (local development).
 * - Private IP ranges, link-local addresses, and cloud metadata endpoints are blocked.
 * - Non-standard ports on public hosts are allowed (common for dev/staging OIDC providers).
 *
 * @throws If the URL is unsafe for server-side fetch
 */
function validateDiscoveryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`OIDC discovery URL is not a valid URL: ${url}`);
  }

  // Scheme validation: only https in production, http only for localhost
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLocalhost) {
    throw new Error(`OIDC discovery URL must use HTTPS: ${url}. ` + `HTTP is only allowed for localhost development.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`OIDC discovery URL must use HTTPS (got ${parsed.protocol}): ${url}`);
  }

  // Blocked hostname check (cloud metadata services)
  if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new Error(`OIDC discovery URL targets a blocked host: ${parsed.hostname}`);
  }

  // Blocked IP pattern check (private networks, link-local, loopback)
  // Skip for localhost — explicitly allowed above for development
  if (!isLocalhost) {
    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(parsed.hostname)) {
        throw new Error(`OIDC discovery URL targets a private/internal address: ${parsed.hostname}`);
      }
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Fetches an OIDC discovery document from the well-known endpoint.
 *
 * Always makes a network request — does NOT use the cache.
 * Prefer {@link getOidcDiscovery} for cached access.
 *
 * @param issuerUrl - OIDC issuer URL (e.g. `https://auth.example.com`)
 * @returns Parsed and validated discovery document
 * @throws If the fetch fails or required fields are missing
 */
export async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscoveryDocument> {
  const normalizedIssuer = issuerUrl.replace(/\/+$/, "");
  const discoveryUrl = `${normalizedIssuer}${WELL_KNOWN_PATH}`;

  // SSRF protection: validate URL before fetching (CWE-918)
  try {
    validateDiscoveryUrl(discoveryUrl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "invalid URL";
    logger.error(LogMessages.SSRF_BLOCKED, discoveryUrl, reason);
    throw err;
  }

  logger.info(LogMessages.FETCHING, discoveryUrl);

  let response: globalThis.Response;
  try {
    response = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    logger.error(LogMessages.FETCH_FAILED, discoveryUrl, message);
    throw new Error(`OIDC discovery fetch failed for ${normalizedIssuer}: ${message}`, { cause: err });
  }

  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed for ${normalizedIssuer}: HTTP ${response.status}. ` +
        `Ensure the provider supports OpenID Connect Discovery at ${discoveryUrl}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  // Validate required fields
  const missing: string[] = [];
  if (typeof data.authorization_endpoint !== "string") missing.push("authorization_endpoint");
  if (typeof data.token_endpoint !== "string") missing.push("token_endpoint");

  if (missing.length > 0) {
    logger.error(LogMessages.MISSING_FIELDS, discoveryUrl, missing.join(", "));
    throw new Error(`OIDC discovery at ${discoveryUrl} is missing required fields: ${missing.join(", ")}`);
  }

  const document: OidcDiscoveryDocument = {
    authorization_endpoint: data.authorization_endpoint as string,
    token_endpoint: data.token_endpoint as string,
    ...(typeof data.userinfo_endpoint === "string" && {
      userinfo_endpoint: data.userinfo_endpoint,
    }),
    ...(typeof data.revocation_endpoint === "string" && {
      revocation_endpoint: data.revocation_endpoint,
    }),
    ...(Array.isArray(data.scopes_supported) && {
      scopes_supported: data.scopes_supported as string[],
    }),
    ...(Array.isArray(data.token_endpoint_auth_methods_supported) && {
      token_endpoint_auth_methods_supported: data.token_endpoint_auth_methods_supported as string[],
    }),
    ...(typeof data.issuer === "string" && { issuer: data.issuer }),
  };

  // RFC 8414: issuer in the discovery document MUST match the requested issuer URL
  if (document.issuer && document.issuer.replace(/\/+$/, "") !== normalizedIssuer) {
    logger.error(LogMessages.ISSUER_MISMATCH, normalizedIssuer, document.issuer);
    throw new Error(
      `OIDC discovery issuer mismatch: requested ${normalizedIssuer} but document declares ${document.issuer}. ` +
        `This may indicate a misconfigured or compromised OIDC provider.`,
    );
  }

  logger.info(
    LogMessages.FETCHED,
    document.authorization_endpoint,
    document.token_endpoint,
    document.userinfo_endpoint ?? "(none)",
  );

  return document;
}

/**
 * Returns an OIDC discovery document, using a TTL-based cache.
 *
 * If a cached document exists and is within the TTL, returns it immediately.
 * Otherwise, fetches a fresh document and updates the cache.
 *
 * @param issuerUrl - OIDC issuer URL (e.g. `https://auth.example.com`)
 * @param ttlMs - Cache TTL in milliseconds (default: 1 hour)
 * @returns Cached or freshly fetched discovery document
 */
export async function getOidcDiscovery(
  issuerUrl: string,
  ttlMs: number = DEFAULT_DISCOVERY_TTL_MS,
): Promise<OidcDiscoveryDocument> {
  const normalizedIssuer = issuerUrl.replace(/\/+$/, "");
  const cached = discoveryCache.get(normalizedIssuer);

  if (cached) {
    const ageMs = Date.now() - cached.fetchedAt;
    if (ageMs < ttlMs) {
      logger.debug(LogMessages.CACHED, normalizedIssuer, Math.floor(ageMs / 1000));
      return cached.document;
    }
    logger.debug(LogMessages.REFRESHING, normalizedIssuer, Math.floor(ageMs / 1000), Math.floor(ttlMs / 1000));
  }

  const document = await fetchOidcDiscovery(normalizedIssuer);

  // Evict oldest entry if cache is full
  if (discoveryCache.size >= MAX_DISCOVERY_CACHE_SIZE && !discoveryCache.has(normalizedIssuer)) {
    const oldestKey = discoveryCache.keys().next().value;
    if (oldestKey !== undefined) discoveryCache.delete(oldestKey);
  }

  discoveryCache.set(normalizedIssuer, { document, fetchedAt: Date.now() });
  return document;
}

/**
 * Clears the OIDC discovery cache.
 * Primarily for testing and hot-reload scenarios.
 */
export function clearOidcDiscoveryCache(): void {
  discoveryCache.clear();
}
