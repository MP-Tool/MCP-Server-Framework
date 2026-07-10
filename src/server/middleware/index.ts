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
 * API Access Log
 * Logs one line per HTTP request/response (method, path, status, duration) to
 * the "api" file-log component. Operational access log, separate from the audit trail.
 */
export { apiAccessLog } from "./api-access-log.js";

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
 * Unified Auth Middleware
 * Validates access tokens from a Bearer or custom header, with required or optional
 * enforcement, via an OAuth provider or token verifier. Sets `req.auth` on success.
 */
export { createAuthMiddleware, extractBearerToken } from "./auth-middleware.js";
export type { AuthMiddlewareOptions, AuthTokenSource, AuthEnforcement } from "./auth-middleware.js";

// ===== Security Logging Utilities =====

/**
 * Sanitizes a string for logging to prevent log injection attacks.
 * Replaces newlines and other control characters.
 */
export { sanitizeForLog, logSecurityEvent } from "./logging.js";
