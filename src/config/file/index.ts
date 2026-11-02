/**
 * Config File Module Barrel Export
 *
 * @module config/file
 */

// Loader (main entry point)
export { loadConfigFile, reportIgnoredConfigFile } from "./loader.js";

// Schema, types & constants
export { mapConfigToEnvKeys, type ConfigFileResult, type AuthSectionData } from "./schema.js";
