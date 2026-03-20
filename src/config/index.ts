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

export {
  frameworkEnvSchema,
  validateConfigConstraints,
  type FrameworkEnvConfig,
  type ConfigConstraintViolation,
} from "./env.js";
export {
  getFrameworkConfig,
  getConfigSource,
  resetConfigCache,
  registerCacheReset,
  applyConfigOverrides,
  setConfigLogger,
} from "./config-cache.js";
export { registerConfigSection, getAppConfig, resetConfigExtensions } from "./extensions.js";

// ============================================================================
// Startup Warning Buffer
// ============================================================================

export { addStartupWarning, flushStartupWarnings, resetStartupWarnings } from "./startup-warnings.js";

// ============================================================================
// Zod Schema Helpers
// ============================================================================

export { booleanFromEnv, commaSeparatedList, optionalCommaSeparatedList } from "../utils/zod-helpers.js";

// ============================================================================
// Config File Support
// ============================================================================

export {
  loadConfigFile,
  configFileSchema,
  CONFIG_FILE_ENV_VAR,
  DISCOVERY_FILENAMES,
  type ConfigFileFormat,
  type ConfigFileResult,
  type ConfigFileData,
  type ConfigSource,
} from "./file/index.js";
