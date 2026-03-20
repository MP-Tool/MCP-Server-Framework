/**
 * Server Routes
 *
 * Express route handlers for server-level endpoints (health, readiness, metrics)
 * and MCP transport routers (Streamable HTTP, legacy SSE).
 *
 * @module server/routes
 */

// ===== Health & Readiness =====

export { createHealthRouter, ReadinessStatus } from "./health.js";
export type { HealthRouterOptions, SseInfoProvider } from "./health.js";

// ===== Prometheus Metrics =====

export { createMetricsRouter } from "./metrics.js";

// ===== MCP Transport Routers =====

export { createStreamableHttpRouter } from "./streamable-http-router.js";
export { createSseRouter, isSseEnabled, getSseSessionCount } from "./sse-router.js";

// ===== OAuth Router =====

export { createOAuthRouter } from "./oauth-router.js";
export type { OAuthRouterOptions } from "./oauth-router.js";
