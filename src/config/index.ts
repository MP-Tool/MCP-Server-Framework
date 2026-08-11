/**
 * Server Framework Configuration
 *
 * Aggregates all framework configuration into a single module.
 * This provides a central access point for all server framework settings.
 *
 * @module config
 */

// ============================================================================
// Environment Configuration
// ============================================================================

export { type FrameworkEnvConfig, type ConfigConstraintViolation } from "./env.js";
export { getFrameworkConfig } from "./config-cache.js";
export { registerConfigSection, getAppConfig } from "./extensions.js";
