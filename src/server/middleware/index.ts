/**
 * Transport Middleware
 *
 * Collection of Express middleware for MCP transport security and validation.
 * These middleware handle concerns that the SDK transport does NOT validate.
 *
 * ## Middleware Stack
 *
 * The following middleware are applied in the default Express pipeline:
 *
 * - **DNS Rebinding Protection** - Validates Host header (MCP MUST, not in SDK)
 * - **Rate Limiting** - Prevents abuse and DoS attacks (not in SDK)
 * - **Protocol Version** - Early rejection of unsupported protocol versions
 *
 * Content-Type, Accept header, and JSON-RPC validation are handled internally
 * by the SDK's `StreamableHTTPServerTransport`.
 *
 * ## Default Middleware Stack Order
 *
 * ```typescript
 * app.use('/mcp', dnsRebindingProtection);  // 1. Security (Express level)
 * app.use('/mcp', createRateLimiter());     // 2. Rate limiting (Express level)
 * app.use('/mcp', validateProtocolVersion); // 3. Protocol version (early reject)
 * // SDK handles: Content-Type, Accept, JSON-RPC
 * ```
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 *
 * @module server/middleware
 */

/**
 * DNS Rebinding Protection (MCP MUST, not handled by SDK)
 * Validates Host header to prevent DNS rebinding attacks
 */
export { dnsRebindingProtection } from "./dns-rebinding.js";

/**
 * Rate Limiting (not handled by SDK)
 * Prevents abuse and DoS attacks
 */
export { createRateLimiter } from "./rate-limit.js";
export type { RateLimiterOptions } from "./rate-limit.js";

/**
 * Protocol Version Validation
 * Early rejection of unsupported protocol versions before reaching the SDK
 */
export { validateProtocolVersion } from "./protocol-version.js";

/**
 * Trust Proxy Resolution
 * Validates and resolves trust proxy values with DNS hostname support
 */
export { resolveTrustProxy, TRUST_PROXY_KEYWORDS } from "./trust-proxy.js";

// ===== Authentication Middleware =====

/**
 * Bearer Auth Middleware
 * Validates access tokens via OAuth provider or custom token verifier
 */
export { createBearerAuth } from "./bearer-auth.js";
export type { BearerAuthOptions } from "./bearer-auth.js";

/**
 * Custom Header Auth Middleware
 * Extracts and validates tokens from custom headers (e.g. X-API-Key)
 */
export { createCustomHeaderAuth } from "./custom-header-auth.js";
export type { CustomHeaderAuthOptions } from "./custom-header-auth.js";

// ===== Security Logging Utilities =====

/**
 * Sanitizes a string for logging to prevent log injection attacks.
 * Replaces newlines and other control characters.
 */
export { sanitizeForLog, logSecurityEvent } from "./logging.js";
